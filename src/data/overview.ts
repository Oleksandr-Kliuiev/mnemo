import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { getSettings } from '../db/settings'
import { CardState, type Card, type Deck, type Settings } from '../db/types'
import { DECK_SEP, isInSubtree } from '../db/repo'
import { dayIndex, DAY_MS } from '../sched/day'
import { buildQueues, type QueueCounts } from '../sched/session'

export interface DeckNode {
  deck: Deck
  depth: number
  children: DeckNode[]
  counts: QueueCounts
  /** All cards in the subtree. */
  total: number
}

export interface Overview {
  settings: Settings
  today: number
  decks: Deck[]
  roots: DeckNode[]
  byId: Map<number, DeckNode>
  totals: QueueCounts
  totalCards: number
  reviewsToday: number
  timeTodayMs: number
  streak: number
  studiedToday: boolean
  /** Average answer time over recent reviews, ms. */
  avgAnswerMs: number
  /** Review cards due tomorrow (for the "all done" message). */
  dueTomorrow: number
}

function learnCount(learnQ: Card[], now: number, aheadMin: number): number {
  const ahead = now + aheadMin * 60_000
  return learnQ.filter((c) => c.due <= ahead || (c.lastReview != null && c.due - c.lastReview >= DAY_MS - 60_000)).length
}

export async function computeStreak(today: number): Promise<{ streak: number; studiedToday: boolean }> {
  const days = (await db.revlog.orderBy('day').uniqueKeys()) as number[]
  const set = new Set(days)
  const studiedToday = set.has(today)
  let d = studiedToday ? today : today - 1
  let streak = 0
  while (set.has(d)) {
    streak++
    d--
  }
  return { streak, studiedToday }
}

export async function loadOverview(now = Date.now()): Promise<Overview> {
  const settings = await getSettings()
  const today = dayIndex(now, settings.dayCutoff)
  const decks = (await db.decks.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  const cards = await db.cards.toArray()
  const revToday = await db.revlog.where('day').equals(today).toArray()

  const cardsByDeck = new Map<number, Card[]>()
  for (const c of cards) {
    let arr = cardsByDeck.get(c.deckId)
    if (!arr) cardsByDeck.set(c.deckId, (arr = []))
    arr.push(c)
  }

  const byName = new Map(decks.map((d) => [d.name, d]))
  const byId = new Map<number, DeckNode>()
  const roots: DeckNode[] = []
  for (const d of decks) {
    const depth = d.name.split(DECK_SEP).length - 1
    const node: DeckNode = { deck: d, depth, children: [], counts: { new: 0, learn: 0, review: 0 }, total: 0 }
    byId.set(d.id, node)
    const i = d.name.lastIndexOf(DECK_SEP)
    const parent = i >= 0 ? byName.get(d.name.slice(0, i)) : undefined
    const pnode = parent ? byId.get(parent.id) : undefined
    if (pnode) pnode.children.push(node)
    else roots.push(node)
  }

  for (const d of decks) {
    const sub = decks.filter((x) => isInSubtree(x.name, d.name))
    const subCards = sub.flatMap((x) => cardsByDeck.get(x.id) ?? [])
    const q = buildQueues(sub, subCards, revToday, today, settings.dayCutoff, { rootDeckId: d.id }, d.id)
    const node = byId.get(d.id)!
    node.counts = { new: q.newQ.length, learn: learnCount(q.learnQ, now, settings.learnAheadMin), review: q.reviewQ.length }
    node.total = subCards.length
  }

  const totals = roots.reduce(
    (acc, r) => ({ new: acc.new + r.counts.new, learn: acc.learn + r.counts.learn, review: acc.review + r.counts.review }),
    { new: 0, learn: 0, review: 0 },
  )

  const recent = await db.revlog.orderBy('time').reverse().limit(300).toArray()
  const avg = recent.length ? recent.reduce((s, r) => s + r.durationMs, 0) / recent.length : 9000
  const avgAnswerMs = Math.min(60_000, Math.max(5_000, avg))
  const { streak, studiedToday } = await computeStreak(today)
  let dueTomorrow = 0
  for (const c of cards) {
    if (c.suspended || c.state !== CardState.Review) continue
    if (dayIndex(c.due, settings.dayCutoff) === today + 1) dueTomorrow++
  }

  return {
    settings,
    today,
    decks,
    roots,
    byId,
    totals,
    totalCards: cards.length,
    reviewsToday: revToday.length,
    timeTodayMs: revToday.reduce((s, r) => s + r.durationMs, 0),
    streak,
    studiedToday,
    avgAnswerMs,
    dueTomorrow,
  }
}

export function useOverview(): Overview | undefined {
  return useLiveQuery(() => loadOverview(), [])
}

/** Rough minutes for the remaining work: a new card is seen about three times on its first day. */
export function estimateMinutes(c: QueueCounts, avgMs: number): number {
  const answers = c.review + c.learn * 1.5 + c.new * 3
  return Math.max(1, Math.round((answers * avgMs) / 60_000))
}

/** Depth-first list of nodes, skipping children of collapsed decks. */
export function flattenTree(roots: DeckNode[]): DeckNode[] {
  const out: DeckNode[] = []
  const walk = (nodes: DeckNode[]) => {
    for (const n of nodes) {
      out.push(n)
      if (!n.deck.collapsed) walk(n.children)
    }
  }
  walk(roots)
  return out
}
