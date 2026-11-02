import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { addNote, builtinTypeId, cloneNoteType, createDeck, ensureBuiltins, saveNoteType } from './repo'

beforeEach(async () => {
  await db.delete()
  await db.open()
  await ensureBuiltins()
})

describe('saveNoteType', () => {
  it('moves field values with their fields and adds cards for new templates', async () => {
    const deckId = await createDeck('D')
    const typeId = await cloneNoteType(await builtinTypeId('basic'), 'Моя')
    const { noteId } = await addNote(typeId, deckId, ['Q', 'A'], [])
    const t = (await db.noteTypes.get(typeId))!
    await saveNoteType(typeId, {
      name: 'Моя',
      css: t.css,
      fields: [
        { name: 'Ответ', origin: 1 },
        { name: 'Вопрос', origin: 0 },
        { name: 'Пример', origin: null },
      ],
      templates: [
        { ...t.templates[0], origin: 0 },
        { name: 'Обратная', qfmt: '{{Ответ}}', afmt: '{{FrontSide}}<hr id=answer>{{Вопрос}}', origin: null },
      ],
    })
    const note = (await db.notes.get(noteId))!
    expect(note.fields).toEqual(['A', 'Q', ''])
    const cards = await db.cards.where('noteId').equals(noteId).toArray()
    expect(cards.map((c) => c.ord).sort()).toEqual([0, 1])
  })
  it('deletes cards of removed templates', async () => {
    const deckId = await createDeck('D')
    const typeId = await cloneNoteType(await builtinTypeId('basic-reverse'), 'Двойная')
    const { noteId } = await addNote(typeId, deckId, ['Q', 'A'], [])
    const t = (await db.noteTypes.get(typeId))!
    const res = await saveNoteType(typeId, { name: t.name, css: t.css, fields: t.fields.map((f, i) => ({ ...f, origin: i })), templates: [{ ...t.templates[1], origin: 1 }] })
    expect(res.cardsRemoved).toBe(1)
    const cards = await db.cards.where('noteId').equals(noteId).toArray()
    expect(cards).toHaveLength(1)
    expect(cards[0].ord).toBe(0)
  })
})
