import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { addNote, builtinTypeId, createDeck, ensureBuiltins, updateDeck } from '../db/repo'
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

  it('buries siblings after answering', async () => {
    const deckId = await seed('R', 1, 10, 'basic-reverse')
    const s = await StudySession.load({ rootDeckId: deckId })
    expect(s.counts().new).toBe(2)
    const t0 = Date.now()
    const a = s.next(t0)
    if (a.type !== 'card') throw new Error('no card')
    await s.answer(a.card, s.preview(a.card, t0)[4], 1000, t0)
    expect(s.counts(t0).new).toBe(0)
    const cards = await db.cards.toArray()
    expect(cards.filter((c) => c.buriedDay === s.today).length).toBe(1)
    await s.undo()
    expect((await db.cards.toArray()).filter((c) => c.buriedDay === s.today).length).toBe(0)
    expect(s.counts(t0).new).toBe(2)
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
