import { describe, expect, it } from 'vitest'
import { compileSearch, type SearchCtx } from './search'
import type { Card, Note } from '../db/types'

const card = (p: Partial<Card> = {}): Card => ({
  id: 1, noteId: 1, deckId: 1, ord: 0, state: 0, due: 0, stability: 0, difficulty: 0, scheduledDays: 0, learningSteps: 0,
  reps: 0, lapses: 0, lastReview: null, suspended: 0, buriedDay: 0, flag: 0, createdAt: Date.now(), modifiedAt: 0, ...p,
})
const note = (text: string, tags: string[] = []): Note => ({ id: 1, typeId: 1, guid: 'g', fields: [text], tags, searchText: text.toLowerCase(), createdAt: 0, updatedAt: 0 })
const ctx = (c: Card, n: Note, deckName = 'Языки::Английский'): SearchCtx => ({ card: c, note: n, deckName, today: 100, now: Date.now(), cutoff: 4 })

describe('search', () => {
  it('matches words, phrases and negation', () => {
    const c = ctx(card(), note('Доброе утро, кот'))
    expect(compileSearch('кот')(c)).toBe(true)
    expect(compileSearch('"доброе утро"')(c)).toBe(true)
    expect(compileSearch('-кот')(c)).toBe(false)
    expect(compileSearch('кот собака')(c)).toBe(false)
  })
  it('filters by deck (with subdecks), tag, state and flag', () => {
    const c = ctx(card({ flag: 2, suspended: 1 }), note('x', ['verbs', 'leech']))
    expect(compileSearch('deck:Языки')(c)).toBe(true)
    expect(compileSearch('deck:"языки::английский"')(c)).toBe(true)
    expect(compileSearch('deck:Математика')(c)).toBe(false)
    expect(compileSearch('tag:verb*')(c)).toBe(true)
    expect(compileSearch('is:suspended is:leech flag:2')(c)).toBe(true)
    expect(compileSearch('is:new')(c)).toBe(true)
    expect(compileSearch('is:review')(c)).toBe(false)
  })
})
