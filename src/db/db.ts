import Dexie, { type EntityTable, type Table } from 'dexie'
import type { Card, Deck, MediaFile, Note, NoteType, ReviewEntry, SettingRow } from './types'

export type MnemoDB = Dexie & {
  decks: EntityTable<Deck, 'id'>
  noteTypes: EntityTable<NoteType, 'id'>
  notes: EntityTable<Note, 'id'>
  cards: EntityTable<Card, 'id'>
  revlog: EntityTable<ReviewEntry, 'id'>
  media: Table<MediaFile, string>
  settings: Table<SettingRow, string>
}

export const db = new Dexie('mnemo') as MnemoDB

db.version(1).stores({
  decks: '++id, name',
  noteTypes: '++id, name, ankiId',
  notes: '++id, typeId, guid, *tags, createdAt, updatedAt',
  cards: '++id, noteId, deckId, [deckId+state], state, due, createdAt',
  revlog: '++id, cardId, deckId, day, time',
  media: 'name',
  settings: 'key',
})

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
