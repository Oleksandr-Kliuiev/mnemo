import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { addNote, builtinTypeId, createDeck, deleteNotes, ensureBuiltins, updateDeck } from '../db/repo'
import { DEFAULT_DECK_CONFIG } from '../db/builtins'
import { StudySession } from './session'
import { CardState } from '../db/types'

async function reset() {
  await db.delete()
  await db.open()
  await ensureBuiltins()
}

async function seed(deckName: string, n: number, newPerDay = 20, type = 'basic') {
  const deckId = await createDeck(deckName)
  await updateDeck(deckId, { config: { ...DEFAULT_DECK_CONFIG, newPerDay } })
  const typeId = await builtinTypeId(type)
  for (let i = 0; i < n; i++) await addNote(typeId, deckId, [`q${deckName}${i}`, `a${i}`], [])
  return deckId
}

describe('StudySession', () => {
  beforeEach(reset)

  it('respects the daily new card limit', async () => {
    const deckId = await seed('A', 8, 5)
    const s = await StudySession.load({ rootDeckId: deckId })
    expect(s.counts().new).toBe(5)
  })

  it('applies parent limits to subdecks', async () => {
    const parent = await seed('P', 3, 4)
    await seed('P::C', 10, 10)
    const s = await StudySession.load({ rootDeckId: parent })
    expect(s.counts().new).toBe(4)
    const child = (await db.decks.where('name').equals('P::C').first())!
    const sc = await StudySession.load({ rootDeckId: child.id })
    expect(sc.counts().new).toBe(10)
  })

  it('moves answered new cards into learning and counts reviews done today', async () => {
    const deckId = await seed('A', 3, 2)
    const s = await StudySession.load({ rootDeckId: deckId })
    const t0 = Date.now()
    const first = s.next(t0)
    expect(first.type).toBe('card')
    if (first.type !== 'card') return
    const p = s.preview(first.card, t0)
    await s.answer(first.card, p[3], 4000, t0)
    expect(s.counts(t0).new).toBe(1)
    expect(s.learnQ.length).toBe(1)
    const saved = await db.cards.get(first.card.id)
    expect(saved!.state).toBe(CardState.Learning)
    expect(await db.revlog.count()).toBe(1)
    // A fresh session today still counts the introduced card against the limit.
    const again = await StudySession.load({ rootDeckId: deckId })
    expect(again.counts().new).toBe(1)
  })

  it('shows the next card instead of repeating the one just answered', async () => {
    const deckId = await seed('A', 2, 2)
    const s = await StudySession.load({ rootDeckId: deckId })
    const t0 = Date.now()
    const a = s.next(t0)
    if (a.type !== 'card') throw new Error('no card')
    await s.answer(a.card, s.preview(a.card, t0)[1], 1000, t0)
    const b = s.next(t0 + 61_000)
    expect(b.type === 'card' && b.card.id).not.toBe(a.card.id)
  })

  it('undo restores the card, the revlog and the queue', async () => {
    const deckId = await seed('A', 2, 5)
    const s = await StudySession.load({ rootDeckId: deckId })
    const t0 = Date.now()
    const a = s.next(t0)
    if (a.type !== 'card') throw new Error('no card')
    await s.answer(a.card, s.preview(a.card, t0)[4], 1000, t0)
    expect((await db.cards.get(a.card.id))!.state).toBe(CardState.Review)
    const back = await s.undo()
    expect(back?.id).toBe(a.card.id)
    expect((await db.cards.get(a.card.id))!.state).toBe(CardState.New)
    expect(await db.revlog.count()).toBe(0)
    const n = s.next(t0)
    expect(n.type === 'card' && n.card.id).toBe(a.card.id)
    expect(s.counts(t0).new).toBe(2)
  })

  it('buries siblings after answering and only restores queued ones on undo', async () => {
    const deckId = await seed('R', 1, 10, 'basic-reverse')
    const s = await StudySession.load({ rootDeckId: deckId })
    // Sibling-aware queue: one card per note per day.
    expect(s.counts().new).toBe(1)
    const t0 = Date.now()
    const a = s.next(t0)
    if (a.type !== 'card') throw new Error('no card')
    await s.answer(a.card, s.preview(a.card, t0)[4], 1000, t0)
    expect(s.counts(t0).new).toBe(0)
    const cards = await db.cards.toArray()
    expect(cards.filter((c) => c.buriedDay === s.today).length).toBe(1)
    await s.undo()
    expect((await db.cards.toArray()).filter((c) => c.buriedDay === s.today).length).toBe(0)
    expect(s.counts(t0).new).toBe(1)
  })

  it('finishes when everything is done', async () => {
    const deckId = await seed('A', 1, 5)
    const s = await StudySession.load({ rootDeckId: deckId })
    const t0 = Date.now()
    const a = s.next(t0)
    if (a.type !== 'card') throw new Error('no card')
    await s.answer(a.card, s.preview(a.card, t0)[4], 1000, t0)
    expect(s.next(t0).type).toBe('done')
  })
})

describe('review fixes', () => {
  beforeEach(reset)

  it('keeps a flag and deck move made while the card was on screen', async () => {
    const deckId = await seed('A', 1, 5)
    const other = await createDeck('A::B')
    const s = await StudySession.load({ rootDeckId: deckId })
    const t0 = Date.now()
    const a = s.next(t0)
    if (a.type !== 'card') throw new Error('no card')
    const p = s.preview(a.card, t0)
    await db.cards.update(a.card.id, { flag: 2, deckId: other })
    await s.answer(a.card, p[3], 1000, t0)
    const saved = (await db.cards.get(a.card.id))!
    expect(saved.flag).toBe(2)
    expect(saved.deckId).toBe(other)
    expect((await db.revlog.toArray())[0].deckId).toBe(other)
  })

  it('does not pull a sibling due later into today on undo', async () => {
    const deckId = await seed('R', 1, 10, 'basic-reverse')
    const [c1, c2] = (await db.cards.toArray()).sort((x, y) => x.ord - y.ord)
    await db.cards.update(c2.id, { state: CardState.Review, due: Date.now() + 30 * 86_400_000, scheduledDays: 30, stability: 30, difficulty: 5, lastReview: Date.now() - 86_400_000, reps: 3 })
    const s = await StudySession.load({ rootDeckId: deckId })
    const t0 = Date.now()
    const a = s.next(t0)
    if (a.type !== 'card') throw new Error('no card')
    expect(a.card.id).toBe(c1.id)
    await s.answer(a.card, s.preview(a.card, t0)[3], 1000, t0)
    await s.undo()
    expect(s.counts(t0).review).toBe(0)
  })

  it('counts at most one new card per note with sibling burying', async () => {
    const deckId = await seed('R', 30, 20, 'basic-reverse')
    const s = await StudySession.load({ rootDeckId: deckId })
    expect(s.counts().new).toBe(20)
    expect(new Set(s.newQ.map((c) => c.noteId)).size).toBe(20)
  })

  it('reverses undo statistics exactly', async () => {
    const deckId = await seed('A', 2, 5)
    const s = await StudySession.load({ rootDeckId: deckId })
    const t0 = Date.now()
    const a = s.next(t0)
    if (a.type !== 'card') throw new Error('no card')
    await s.answer(a.card, s.preview(a.card, t0)[1], 3000, t0)
    await s.undo()
    expect(s.stats).toEqual({ answered: 0, again: 0, timeMs: 0, newSeen: 0 })
  })

  it('never recreates cards of a deleted note on undo', async () => {
    const deckId = await seed('A', 2, 5)
    const s = await StudySession.load({ rootDeckId: deckId })
    const t0 = Date.now()
    const a = s.next(t0)
    if (a.type !== 'card') throw new Error('no card')
    await s.answer(a.card, s.preview(a.card, t0)[3], 1000, t0)
    await deleteNotes([a.card.noteId])
    expect(await s.undo()).toBeNull()
    expect(await db.cards.get(a.card.id)).toBeUndefined()
  })

  it('notices a new study day', async () => {
    const deckId = await seed('A', 1, 5)
    const late = new Date(2026, 9, 20, 3, 50).getTime()
    const s = await StudySession.load({ rootDeckId: deckId }, late)
    expect(s.isStale(late + 5 * 60_000)).toBe(false)
    expect(s.isStale(late + 20 * 60_000)).toBe(true)
  })
})
