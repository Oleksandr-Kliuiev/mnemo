import { db } from '../db/db'
import { getSettings } from '../db/settings'
import { CardState, type Card, type Deck, type Grade, type ReviewEntry, type Settings } from '../db/types'
import { DECK_SEP, isInSubtree } from '../db/repo'
import { dayIndex, DAY_MS } from './day'
import { finalizeOutcome, previewAnswers, schedConfig, type AnswerOutcome, type AnswerPreview, type SchedConfig } from './fsrs'

export type QueueKind = 'new' | 'learn' | 'review'

export interface SessionOptions {
  /** null = all decks. */
  rootDeckId: number | null
  /** Extra new cards allowed today on top of the deck limit (custom study). */
  extraNew?: number
  /** Also show review cards due within this many days (custom study). */
  reviewAheadDays?: number
}

export interface QueueCounts {
  new: number
  learn: number
  review: number
}

export type NextResult =
  | { type: 'card'; card: Card; kind: QueueKind }
  | { type: 'wait'; until: number; count: number }
  | { type: 'done' }

/** A sibling hidden by an action, and the queue it was taken from (null = it was not queued). */
interface Buried {
  id: number
  from: QueueKind | null
}

type HistoryEntry =
  | {
      kind: 'answer'
      before: Card
      after: Card
      from: QueueKind
      revId: number
      buried: Buried[]
      leechTagged: boolean
      grade: Grade
      durationMs: number
      wasNew: boolean
    }
  | { kind: 'bury' | 'suspend'; card: Card; from: QueueKind; buried: Buried[] }

export interface SessionStats {
  answered: number
  again: number
  timeMs: number
  newSeen: number
}

/** Fields an answer changes; everything else is taken from the row in the database. */
const SCHEDULING_FIELDS = [
  'state',
  'due',
  'stability',
  'difficulty',
  'scheduledDays',
  'learningSteps',
  'reps',
  'lapses',
  'lastReview',
  'modifiedAt',
] as const

const MAX_ANSWER_MS = 5 * 60_000

/** Learning cards with steps of a day or more are scheduled by day, like reviews. */
function isInterday(c: Card): boolean {
  return c.lastReview != null && c.due - c.lastReview >= DAY_MS - 60_000
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export class StudySession {
  settings!: Settings
  today = 0
  decks = new Map<number, Deck>()
  deckIds = new Set<number>()
  newQ: Card[] = []
  reviewQ: Card[] = []
  learnQ: Card[] = []
  stats: SessionStats = { answered: 0, again: 0, timeMs: 0, newSeen: 0 }
  private shownNew = 0
  private shownReview = 0
  private totalNew = 0
  private totalReview = 0
  private lastCardId: number | null = null
  private forced: { card: Card; kind: QueueKind } | null = null
  private history: HistoryEntry[] = []
  private cfgCache = new Map<number, SchedConfig>()

  private constructor(readonly opts: SessionOptions) {}

  static async load(opts: SessionOptions, now = Date.now()): Promise<StudySession> {
    const s = new StudySession(opts)
    await s.reload(now)
    return s
  }

  get canUndo(): boolean {
    return this.history.length > 0
  }

  /** True when the study day changed since the queues were built (e.g. past 04:00). */
  isStale(now = Date.now()): boolean {
    return dayIndex(now, this.settings.dayCutoff) !== this.today
  }

  config(deckId: number): SchedConfig {
    let cfg = this.cfgCache.get(deckId)
    if (!cfg) {
      cfg = schedConfig(this.settings, this.decks.get(deckId)?.config.desiredRetention)
      this.cfgCache.set(deckId, cfg)
    }
    return cfg
  }

  preview(card: Card, now = Date.now()): AnswerPreview {
    return previewAnswers(card, now, this.config(card.deckId))
  }

  async reload(now = Date.now()): Promise<void> {
    this.settings = await getSettings()
    this.cfgCache.clear()
    this.today = dayIndex(now, this.settings.dayCutoff)
    const allDecks = await db.decks.toArray()
    allDecks.sort((a, b) => a.name.localeCompare(b.name))
    this.decks = new Map(allDecks.map((d) => [d.id, d]))
    const root = this.opts.rootDeckId != null ? this.decks.get(this.opts.rootDeckId) : undefined
    const inScope = root ? allDecks.filter((d) => isInSubtree(d.name, root.name)) : allDecks
    this.deckIds = new Set(inScope.map((d) => d.id))

    const cards = await db.cards.where('deckId').anyOf([...this.deckIds]).toArray()
    const revToday = await db.revlog.where('day').equals(this.today).toArray()
    const { newQ, reviewQ, learnQ } = buildQueues(inScope, cards, revToday, this.today, this.settings.dayCutoff, this.opts, root?.id ?? null, this.settings.burySiblings)
    this.newQ = newQ
    this.reviewQ = reviewQ
    this.learnQ = learnQ
    this.totalNew = newQ.length
    this.totalReview = reviewQ.length
    this.shownNew = 0
    this.shownReview = 0
    this.forced = null
  }

  counts(now = Date.now()): QueueCounts {
    const ahead = now + this.settings.learnAheadMin * 60_000
    return {
      new: this.newQ.length,
      learn: this.learnQ.filter((c) => c.due <= ahead || isInterday(c)).length,
      review: this.reviewQ.length,
    }
  }

  /** Cards answered + cards left, for the progress bar. */
  progress(now = Date.now()): { done: number; total: number } {
    const c = this.counts(now)
    const left = c.new + c.review + this.learnQ.length
    return { done: this.stats.answered, total: this.stats.answered + left }
  }

  private pickMain(): { card: Card; kind: QueueKind } | null {
    const n = this.newQ[0]
    const r = this.reviewQ[0]
    if (!n && !r) return null
    if (!n) return { card: r, kind: 'review' }
    if (!r) return { card: n, kind: 'new' }
    switch (this.settings.reviewOrder) {
      case 'newFirst':
        return { card: n, kind: 'new' }
      case 'reviewsFirst':
        return { card: r, kind: 'review' }
      default: {
        // Spread new cards evenly between reviews.
        const newRatio = (this.shownNew + 1) / (this.totalNew + 1)
        const revRatio = (this.shownReview + 1) / (this.totalReview + 1)
        return newRatio <= revRatio ? { card: n, kind: 'new' } : { card: r, kind: 'review' }
      }
    }
  }

  next(now = Date.now()): NextResult {
    if (this.forced) {
      const f = this.forced
      this.forced = null
      return { type: 'card', ...f }
    }
    this.learnQ.sort((a, b) => a.due - b.due)
    const dueLearn = this.learnQ.filter((c) => c.due <= now || isInterday(c))
    const main = this.pickMain()
    if (dueLearn.length) {
      const first = dueLearn[0]
      if (first.id === this.lastCardId) {
        // Avoid showing the same card twice in a row when anything else is available.
        if (dueLearn[1]) return { type: 'card', card: dueLearn[1], kind: 'learn' }
        if (main) return { type: 'card', ...main }
      }
      return { type: 'card', card: first, kind: 'learn' }
    }
    if (main) return { type: 'card', ...main }
    const ahead = now + this.settings.learnAheadMin * 60_000
    const soon = this.learnQ.find((c) => c.due <= ahead)
    if (soon) return { type: 'card', card: soon, kind: 'learn' }
    if (this.learnQ.length) return { type: 'wait', until: this.learnQ[0].due, count: this.learnQ.length }
    return { type: 'done' }
  }

  private removeFromQueues(id: number): QueueKind | null {
    for (const [q, kind] of [
      [this.newQ, 'new'],
      [this.reviewQ, 'review'],
      [this.learnQ, 'learn'],
    ] as const) {
      const i = q.findIndex((c) => c.id === id)
      if (i >= 0) {
        q.splice(i, 1)
        return kind
      }
    }
    return null
  }

  private async siblingsToBury(card: Card): Promise<Card[]> {
    if (!this.settings.burySiblings) return []
    const sibs = await db.cards.where('noteId').equals(card.noteId).toArray()
    return sibs.filter(
      (c) =>
        c.id !== card.id &&
        !c.suspended &&
        c.buriedDay !== this.today &&
        (c.state === CardState.New || c.state === CardState.Review),
    )
  }

  async answer(card: Card, outcome: AnswerOutcome, durationMs: number, now = Date.now()): Promise<{ leech: boolean }> {
    const cfg = this.config(card.deckId)
    const final = finalizeOutcome(outcome, now, cfg)
    const threshold = Math.max(1, this.settings.leechThreshold)
    const lapsed = card.state === CardState.Review && outcome.grade === 1
    const leech =
      lapsed && final.card.lapses >= threshold && (final.card.lapses - threshold) % Math.max(1, Math.floor(threshold / 2)) === 0
    const siblings = await this.siblingsToBury(card)
    const duration = Math.min(Math.max(0, durationMs), MAX_ANSWER_MS)
    let leechTagged = false
    let revId = 0
    let before: Card = card
    let written: Card = final.card
    await db.transaction('rw', db.cards, db.revlog, db.notes, async () => {
      // Start from the stored row: a flag, deck move or suspension made while the card
      // was on screen must survive the answer. Only scheduling fields are replaced.
      const fresh = await db.cards.get(card.id)
      if (!fresh) throw new Error('Карточка была удалена')
      before = fresh
      written = { ...fresh }
      for (const k of SCHEDULING_FIELDS) (written as unknown as Record<string, unknown>)[k] = final.card[k]
      if (leech && this.settings.leechAction === 'suspend') written.suspended = 1
      await db.cards.put(written)
      const entry: ReviewEntry = { ...final.entry, deckId: fresh.deckId, durationMs: duration }
      revId = (await db.revlog.add(entry)) as number
      if (siblings.length) {
        await db.cards.where('id').anyOf(siblings.map((c) => c.id)).modify({ buriedDay: this.today })
      }
      if (leech) {
        const note = await db.notes.get(card.noteId)
        if (note && !note.tags.includes('leech')) {
          await db.notes.update(note.id, { tags: [...note.tags, 'leech'], searchText: note.searchText + ' leech' })
          leechTagged = true
        }
      }
    })
    const from = this.removeFromQueues(card.id) ?? 'learn'
    const buried = siblings.map((s) => ({ id: s.id, from: this.removeFromQueues(s.id) }))
    if (from === 'new') this.shownNew++
    if (from === 'review') this.shownReview++
    if (
      !written.suspended &&
      this.deckIds.has(written.deckId) &&
      (written.state === CardState.Learning || written.state === CardState.Relearning) &&
      !isInterday(written) &&
      dayIndex(written.due, this.settings.dayCutoff) <= this.today
    ) {
      this.learnQ.push(written)
      this.learnQ.sort((a, b) => a.due - b.due)
    }
    const wasNew = before.state === CardState.New
    this.history.push({ kind: 'answer', before, after: written, from, revId, buried, leechTagged, grade: outcome.grade, durationMs: duration, wasNew })
    this.lastCardId = card.id
    this.stats.answered++
    this.stats.timeMs += duration
    if (outcome.grade === 1) this.stats.again++
    if (wasNew) this.stats.newSeen++
    return { leech }
  }

  /** Hide the card (and its siblings) until tomorrow. */
  async bury(card: Card): Promise<void> {
    const siblings = await this.siblingsToBury(card)
    const ids = [card.id, ...siblings.map((s) => s.id)]
    await db.cards.where('id').anyOf(ids).modify({ buriedDay: this.today })
    const from = this.removeFromQueues(card.id) ?? 'learn'
    const buried = siblings.map((s) => ({ id: s.id, from: this.removeFromQueues(s.id) }))
    this.history.push({ kind: 'bury', card, from, buried })
  }

  async suspend(card: Card): Promise<void> {
    await db.cards.update(card.id, { suspended: 1 })
    const from = this.removeFromQueues(card.id) ?? 'learn'
    this.history.push({ kind: 'suspend', card, from, buried: [] })
  }

  /** Drop a card from the session (e.g. deleted while studying). */
  forget(cardId: number): void {
    this.removeFromQueues(cardId)
    this.history = this.history.filter((h) => (h.kind === 'answer' ? h.before.id : h.card.id) !== cardId)
  }

  /** Drop every card of a deleted note from the queues and the undo history. */
  forgetNote(noteId: number): void {
    for (const q of [this.newQ, this.reviewQ, this.learnQ]) {
      for (let i = q.length - 1; i >= 0; i--) if (q[i].noteId === noteId) q.splice(i, 1)
    }
    this.history = this.history.filter((h) => (h.kind === 'answer' ? h.before.noteId : h.card.noteId) !== noteId)
  }

  /** Replace the in-memory copy after an edit (deck change etc.). */
  refreshCard(card: Card): void {
    for (const q of [this.newQ, this.reviewQ, this.learnQ]) {
      const i = q.findIndex((c) => c.id === card.id)
      if (i >= 0) q[i] = card
    }
  }

  /** Undo the last action. Returns the card that should be shown again. */
  async undo(): Promise<Card | null> {
    const h = this.history.pop()
    if (!h) return null
    const card = h.kind === 'answer' ? h.before : h.card
    // The note may have been deleted since (e.g. from the editor): never resurrect its cards.
    if (!(await db.notes.get(card.noteId))) {
      this.forgetNote(card.noteId)
      return this.undo()
    }
    if (h.kind === 'answer') {
      await db.transaction('rw', db.cards, db.revlog, db.notes, async () => {
        await db.cards.put(h.before)
        await db.revlog.delete(h.revId)
        if (h.buried.length) await db.cards.where('id').anyOf(h.buried.map((b) => b.id)).modify({ buriedDay: 0 })
        if (h.leechTagged) {
          const note = await db.notes.get(h.before.noteId)
          if (note) {
            await db.notes.update(note.id, {
              tags: note.tags.filter((t) => t !== 'leech'),
              searchText: note.searchText.replace(/ leech$/, ''),
            })
          }
        }
      })
      this.removeFromQueues(h.after.id)
      await this.restoreBuried(h.buried)
      if (h.from === 'new') this.shownNew = Math.max(0, this.shownNew - 1)
      if (h.from === 'review') this.shownReview = Math.max(0, this.shownReview - 1)
      this.stats.answered = Math.max(0, this.stats.answered - 1)
      this.stats.timeMs = Math.max(0, this.stats.timeMs - h.durationMs)
      if (h.grade === 1) this.stats.again = Math.max(0, this.stats.again - 1)
      if (h.wasNew) this.stats.newSeen = Math.max(0, this.stats.newSeen - 1)
      this.putBack(h.before, h.from)
      this.forced = { card: h.before, kind: h.from }
      this.lastCardId = null
      return h.before
    }
    const restore: Partial<Card> = h.kind === 'bury' ? { buriedDay: 0 } : { suspended: 0 }
    await db.cards.update(h.card.id, restore)
    if (h.buried.length) await db.cards.where('id').anyOf(h.buried.map((b) => b.id)).modify({ buriedDay: 0 })
    await this.restoreBuried(h.buried)
    const fresh = { ...((await db.cards.get(h.card.id)) ?? h.card), ...restore }
    this.putBack(fresh, h.from)
    this.forced = { card: fresh, kind: h.from }
    return fresh
  }

  private putBack(card: Card, from: QueueKind) {
    if (from === 'new') this.newQ.unshift(card)
    else if (from === 'review') this.reviewQ.unshift(card)
    else {
      this.learnQ.push(card)
      this.learnQ.sort((a, b) => a.due - b.due)
    }
  }

  /** Put buried siblings back only into the queues they were taken from. */
  private async restoreBuried(list: Buried[]) {
    const queued = list.filter((b) => b.from != null)
    if (!queued.length) return
    const cards = await db.cards.bulkGet(queued.map((b) => b.id))
    queued.forEach((b, i) => {
      const c = cards[i]
      if (!c || c.suspended) return
      if (b.from === 'new') this.newQ.push(c)
      else if (b.from === 'review') this.reviewQ.push(c)
      else this.learnQ.push(c)
    })
    this.learnQ.sort((a, b) => a.due - b.due)
  }
}

/**
 * Build today's queues. Limits apply per deck to the whole subtree (like Anki's v3 scheduler):
 * a card is taken only if its deck and every ancestor in scope still have room.
 * With sibling burying on, a note contributes at most one new/review card per day,
 * so the counts match what the session will really show.
 */
export function buildQueues(
  decksInScope: Deck[],
  cards: Card[],
  revToday: ReviewEntry[],
  today: number,
  cutoff: number,
  opts: SessionOptions,
  rootId: number | null,
  burySiblings = true,
): { newQ: Card[]; reviewQ: Card[]; learnQ: Card[] } {
  const byName = new Map(decksInScope.map((d) => [d.name, d]))
  const ancestors = (d: Deck): Deck[] => {
    const out: Deck[] = [d]
    let name = d.name
    for (;;) {
      const i = name.lastIndexOf(DECK_SEP)
      if (i < 0) break
      name = name.slice(0, i)
      const p = byName.get(name)
      if (!p) break
      out.push(p)
    }
    return out
  }
  const deckById = new Map(decksInScope.map((d) => [d.id, d]))

  // Done today per deck (own cards only), then aggregated over subtrees through ancestors().
  const doneNewOwn = new Map<number, Set<number>>()
  const doneRevOwn = new Map<number, Set<number>>()
  for (const r of revToday) {
    const map = r.state === CardState.New ? doneNewOwn : r.state === CardState.Review ? doneRevOwn : null
    if (!map) continue
    let set = map.get(r.deckId)
    if (!set) map.set(r.deckId, (set = new Set()))
    set.add(r.cardId)
  }
  const remainingNew = new Map<number, number>()
  const remainingRev = new Map<number, number>()
  for (const d of decksInScope) {
    const extra = d.id === rootId ? (opts.extraNew ?? 0) : 0
    remainingNew.set(d.id, d.config.newPerDay + extra)
    remainingRev.set(d.id, d.config.reviewsPerDay)
  }
  for (const d of decksInScope) {
    const nNew = doneNewOwn.get(d.id)?.size ?? 0
    const nRev = doneRevOwn.get(d.id)?.size ?? 0
    for (const a of ancestors(d)) {
      remainingNew.set(a.id, (remainingNew.get(a.id) ?? 0) - nNew)
      remainingRev.set(a.id, (remainingRev.get(a.id) ?? 0) - nRev)
    }
  }

  const ahead = opts.reviewAheadDays ?? 0
  const newBy = new Map<number, Card[]>()
  const revBy = new Map<number, Card[]>()
  const learnQ: Card[] = []
  const dueDay = new Map<number, number>()
  const dayOf = (c: Card) => {
    let d = dueDay.get(c.id)
    if (d === undefined) dueDay.set(c.id, (d = dayIndex(c.due, cutoff)))
    return d
  }
  for (const c of cards) {
    if (c.suspended || c.buriedDay === today) continue
    const deck = deckById.get(c.deckId)
    if (!deck) continue
    if (c.state === CardState.New) {
      let arr = newBy.get(c.deckId)
      if (!arr) newBy.set(c.deckId, (arr = []))
      arr.push(c)
    } else if (c.state === CardState.Review) {
      if (dayOf(c) <= today + ahead) {
        let arr = revBy.get(c.deckId)
        if (!arr) revBy.set(c.deckId, (arr = []))
        arr.push(c)
      }
    } else if (dayOf(c) <= today) {
      learnQ.push(c)
    }
  }

  const usedNotes = new Set<number>()
  const take = (pool: Map<number, Card[]>, remaining: Map<number, number>): Card[] => {
    const out: Card[] = []
    for (const d of decksInScope) {
      const arr = pool.get(d.id)
      if (!arr) continue
      const chain = ancestors(d)
      for (const c of arr) {
        if (chain.some((a) => (remaining.get(a.id) ?? 0) <= 0)) break
        // A sibling would be buried as soon as its partner is answered: skip it without using the limit.
        if (burySiblings && usedNotes.has(c.noteId)) continue
        usedNotes.add(c.noteId)
        out.push(c)
        for (const a of chain) remaining.set(a.id, (remaining.get(a.id) ?? 0) - 1)
      }
    }
    return out
  }

  for (const [deckId, arr] of newBy) {
    const deck = deckById.get(deckId)!
    if (deck.config.newOrder === 'random') shuffle(arr)
    else arr.sort((a, b) => a.due - b.due || a.ord - b.ord)
  }
  for (const arr of revBy.values()) {
    // Most overdue first; same-day cards in random order so siblings don't cluster.
    shuffle(arr)
    arr.sort((a, b) => dayOf(a) - dayOf(b))
  }
  // Reviews first, as in Anki: a note due for review keeps its new siblings for another day.
  const reviewQ = take(revBy, remainingRev)
  const newQ = take(newBy, remainingNew)
  // Interleave decks: reviews sorted globally by due day, stable random within a day.
  reviewQ.sort((a, b) => dayOf(a) - dayOf(b))
  learnQ.sort((a, b) => a.due - b.due)
  return { newQ, reviewQ, learnQ }
}
