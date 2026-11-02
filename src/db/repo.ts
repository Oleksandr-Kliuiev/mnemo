import { db } from './db'
import { BUILTIN_NOTE_TYPES, DECK_COLORS, DEFAULT_DECK_CONFIG } from './builtins'
import { CardState, type Card, type Deck, type DeckConfig, type Note, type NoteType } from './types'
import { cardOrdinals } from '../render/template'
import { plainText } from '../render/html'
import { forgetCard } from '../sched/fsrs'

export const DECK_SEP = '::'

// ── Helpers ───────────────────────────────────────────────────────────────────

const GUID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~'

export function newGuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return Array.from(bytes, (b) => GUID_CHARS[b % GUID_CHARS.length]).join('')
}

export function noteSearchText(fields: string[], tags: string[]): string {
  return (plainText(fields.join('   ')) + ' ' + tags.join(' ')).toLowerCase()
}

export function normalizeDeckName(name: string): string {
  return name
    .split(DECK_SEP)
    .map((p) => p.trim())
    .filter(Boolean)
    .join(DECK_SEP)
}

export function leafName(name: string): string {
  const i = name.lastIndexOf(DECK_SEP)
  return i < 0 ? name : name.slice(i + DECK_SEP.length)
}

export function parentName(name: string): string | null {
  const i = name.lastIndexOf(DECK_SEP)
  return i < 0 ? null : name.slice(0, i)
}

export function isInSubtree(name: string, root: string): boolean {
  return name === root || name.startsWith(root + DECK_SEP)
}

export function newCard(noteId: number, deckId: number, ord: number, now: number, position: number): Omit<Card, 'id'> {
  return {
    noteId,
    deckId,
    ord,
    state: CardState.New,
    due: position,
    stability: 0,
    difficulty: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    lastReview: null,
    suspended: 0,
    buriedDay: 0,
    flag: 0,
    createdAt: now,
    modifiedAt: now,
  }
}

// ── Note types ────────────────────────────────────────────────────────────────

export async function ensureBuiltins(): Promise<void> {
  await db.transaction('rw', db.noteTypes, async () => {
    const existing = await db.noteTypes.toArray()
    const have = new Set(existing.map((t) => t.builtin).filter(Boolean))
    const now = Date.now()
    for (const def of BUILTIN_NOTE_TYPES) {
      if (!have.has(def.builtin)) {
        await db.noteTypes.add({ ...structuredClone(def), createdAt: now, updatedAt: now } as NoteType)
      }
    }
  })
}

export async function builtinTypeId(key: string): Promise<number> {
  const t = (await db.noteTypes.toArray()).find((x) => x.builtin === key)
  if (!t) throw new Error(`Нет встроенного типа ${key}`)
  return t.id
}

// ── Decks ─────────────────────────────────────────────────────────────────────

export async function findDeckByName(name: string): Promise<Deck | undefined> {
  return db.decks.where('name').equals(name).first()
}

/** Create a deck (and any missing parents). Returns the id of the deepest deck. */
export async function createDeck(rawName: string, opts: Partial<Pick<Deck, 'color' | 'emoji' | 'description'>> & { config?: Partial<DeckConfig> } = {}): Promise<number> {
  const name = normalizeDeckName(rawName)
  if (!name) throw new Error('Пустое имя колоды')
  return db.transaction('rw', db.decks, async () => {
    const parts = name.split(DECK_SEP)
    let id = 0
    const count = await db.decks.count()
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join(DECK_SEP)
      const found = await findDeckByName(path)
      if (found) {
        id = found.id
        continue
      }
      const isLeaf = i === parts.length
      id = (await db.decks.add({
        name: path,
        color: (isLeaf && opts.color) || DECK_COLORS[(count + i - 1) % DECK_COLORS.length],
        emoji: (isLeaf && opts.emoji) || '',
        description: (isLeaf && opts.description) || '',
        config: { ...DEFAULT_DECK_CONFIG, ...(isLeaf ? opts.config : {}) },
        collapsed: false,
        createdAt: Date.now(),
      } as Deck)) as number
    }
    return id
  })
}

export async function renameDeck(id: number, rawName: string): Promise<void> {
  const name = normalizeDeckName(rawName)
  if (!name) throw new Error('Пустое имя колоды')
  await db.transaction('rw', db.decks, async () => {
    const deck = await db.decks.get(id)
    if (!deck || deck.name === name) return
    const clash = await findDeckByName(name)
    if (clash && clash.id !== id) throw new Error('Колода с таким именем уже есть')
    if (isInSubtree(name, deck.name)) throw new Error('Нельзя переместить колоду внутрь самой себя')
    const all = await db.decks.toArray()
    for (const d of all) {
      if (isInSubtree(d.name, deck.name)) {
        await db.decks.update(d.id, { name: name + d.name.slice(deck.name.length) })
      }
    }
    const parent = parentName(name)
    if (parent && !(await findDeckByName(parent))) {
      // Create missing parents outside of the loop above.
      await createDeck(parent)
    }
  })
}

export async function subtreeDeckIds(rootId: number): Promise<number[]> {
  const root = await db.decks.get(rootId)
  if (!root) return []
  const all = await db.decks.toArray()
  return all.filter((d) => isInSubtree(d.name, root.name)).map((d) => d.id)
}

/** Delete a deck with its subdecks and their cards; notes left without cards are removed too. */
export async function deleteDeck(id: number): Promise<number> {
  const ids = await subtreeDeckIds(id)
  return db.transaction('rw', db.decks, db.cards, db.notes, async () => {
    const cards = await db.cards.where('deckId').anyOf(ids).toArray()
    const noteIds = [...new Set(cards.map((c) => c.noteId))]
    await db.cards.bulkDelete(cards.map((c) => c.id))
    const orphan: number[] = []
    for (const nid of noteIds) {
      if ((await db.cards.where('noteId').equals(nid).count()) === 0) orphan.push(nid)
    }
    await db.notes.bulkDelete(orphan)
    await db.decks.bulkDelete(ids)
    return cards.length
  })
}

export async function updateDeck(id: number, patch: Partial<Omit<Deck, 'id' | 'name'>>): Promise<void> {
  await db.decks.update(id, patch)
}

// ── Notes and cards ───────────────────────────────────────────────────────────

export interface AddNoteResult {
  noteId: number
  cards: number
}

export async function addNote(typeId: number, deckId: number, fields: string[], tags: string[]): Promise<AddNoteResult> {
  const nt = await db.noteTypes.get(typeId)
  if (!nt) throw new Error('Тип записи не найден')
  const ords = cardOrdinals(nt.kind, nt.templates, nt.fields.map((f) => f.name), fields)
  if (ords.length === 0) {
    throw new Error(nt.kind === 'cloze' ? 'Добавьте хотя бы один пропуск {{c1::…}}' : 'Заполните лицевую сторону')
  }
  const now = Date.now()
  return db.transaction('rw', db.notes, db.cards, async () => {
    const noteId = (await db.notes.add({
      typeId,
      guid: newGuid(),
      fields,
      tags,
      searchText: noteSearchText(fields, tags),
      createdAt: now,
      updatedAt: now,
    } as Note)) as number
    await db.cards.bulkAdd(ords.map((ord) => newCard(noteId, deckId, ord, now, now + ord) as Card))
    return { noteId, cards: ords.length }
  })
}

/** Save edited fields/tags. Cards for newly filled templates or new cloze numbers are created. */
export async function updateNote(noteId: number, fields: string[], tags: string[], deckIdForNewCards?: number): Promise<number> {
  const note = await db.notes.get(noteId)
  if (!note) throw new Error('Запись не найдена')
  const nt = await db.noteTypes.get(note.typeId)
  if (!nt) throw new Error('Тип записи не найден')
  const now = Date.now()
  return db.transaction('rw', db.notes, db.cards, async () => {
    await db.notes.update(noteId, { fields, tags, searchText: noteSearchText(fields, tags), updatedAt: now })
    const cards = await db.cards.where('noteId').equals(noteId).toArray()
    const have = new Set(cards.map((c) => c.ord))
    const want = cardOrdinals(nt.kind, nt.templates, nt.fields.map((f) => f.name), fields)
    const deckId = deckIdForNewCards ?? cards[0]?.deckId
    const missing = want.filter((o) => !have.has(o))
    if (missing.length && deckId != null) {
      await db.cards.bulkAdd(missing.map((ord) => newCard(noteId, deckId, ord, now, now + ord) as Card))
    }
    return missing.length
  })
}

export async function deleteNotes(noteIds: number[]): Promise<void> {
  await db.transaction('rw', db.notes, db.cards, async () => {
    await db.cards.where('noteId').anyOf(noteIds).delete()
    await db.notes.bulkDelete(noteIds)
  })
}

export async function deleteCards(cardIds: number[]): Promise<void> {
  await db.transaction('rw', db.notes, db.cards, async () => {
    const cards = (await db.cards.bulkGet(cardIds)).filter(Boolean) as Card[]
    await db.cards.bulkDelete(cardIds)
    const noteIds = [...new Set(cards.map((c) => c.noteId))]
    for (const nid of noteIds) {
      if ((await db.cards.where('noteId').equals(nid).count()) === 0) await db.notes.delete(nid)
    }
  })
}

export async function moveCards(cardIds: number[], deckId: number): Promise<void> {
  const now = Date.now()
  await db.cards.where('id').anyOf(cardIds).modify({ deckId, modifiedAt: now })
}

export async function setSuspended(cardIds: number[], suspended: boolean): Promise<void> {
  const now = Date.now()
  await db.cards.where('id').anyOf(cardIds).modify({ suspended: suspended ? 1 : 0, modifiedAt: now })
}

export async function setFlag(cardIds: number[], flag: number): Promise<void> {
  await db.cards.where('id').anyOf(cardIds).modify({ flag })
}

export async function buryCards(cardIds: number[], day: number): Promise<void> {
  await db.cards.where('id').anyOf(cardIds).modify({ buriedDay: day })
}

export async function forgetCards(cardIds: number[]): Promise<void> {
  const now = Date.now()
  await db.transaction('rw', db.cards, async () => {
    const cards = (await db.cards.bulkGet(cardIds)).filter(Boolean) as Card[]
    await db.cards.bulkPut(cards.map((c, i) => forgetCard(c, now, now + i)))
  })
}

export async function noteWithType(noteId: number): Promise<{ note: Note; type: NoteType } | null> {
  const note = await db.notes.get(noteId)
  if (!note) return null
  const type = await db.noteTypes.get(note.typeId)
  if (!type) return null
  return { note, type }
}

/** Notes of the same type whose first field matches (for duplicate warnings). */
export async function findDuplicates(typeId: number, firstField: string, excludeNoteId?: number): Promise<number> {
  const key = plainText(firstField).toLowerCase()
  if (!key) return 0
  let n = 0
  await db.notes
    .where('typeId')
    .equals(typeId)
    .each((note) => {
      if (note.id !== excludeNoteId && plainText(note.fields[0] ?? '').toLowerCase() === key) n++
    })
  return n
}

// ── Note type editing ─────────────────────────────────────────────────────────

export interface EditedField {
  name: string
  sticky?: boolean
  /** Index of this field in the saved type, null for a new field. */
  origin: number | null
}

export interface EditedTemplate {
  name: string
  qfmt: string
  afmt: string
  origin: number | null
}

export interface NoteTypeEdit {
  name: string
  css: string
  fields: EditedField[]
  templates: EditedTemplate[]
}

/**
 * Save a note type and bring its notes and cards in line:
 * field values follow their field, cards follow their template,
 * cards of removed templates are deleted and new templates get cards.
 */
export async function saveNoteType(typeId: number, edit: NoteTypeEdit): Promise<{ cardsAdded: number; cardsRemoved: number }> {
  const now = Date.now()
  return db.transaction('rw', db.noteTypes, db.notes, db.cards, async () => {
    const old = await db.noteTypes.get(typeId)
    if (!old) throw new Error('Тип записи не найден')
    const fields = edit.fields.map((f) => ({ name: f.name.trim(), sticky: f.sticky }))
    const templates = old.kind === 'cloze' ? edit.templates.slice(0, 1) : edit.templates
    await db.noteTypes.update(typeId, {
      name: edit.name.trim() || old.name,
      css: edit.css,
      fields,
      templates: templates.map(({ name, qfmt, afmt }) => ({ name: name.trim() || 'Карточка', qfmt, afmt })),
      sortField: Math.min(old.sortField, fields.length - 1),
      updatedAt: now,
    })
    const fieldsChanged =
      edit.fields.length !== old.fields.length || edit.fields.some((f, i) => f.origin !== i)
    const ordMap = new Map<number, number>()
    templates.forEach((t, i) => t.origin != null && ordMap.set(t.origin, i))
    const templatesChanged = templates.length !== old.templates.length || templates.some((t, i) => t.origin !== i)
    let cardsAdded = 0
    let cardsRemoved = 0
    const notes = await db.notes.where('typeId').equals(typeId).toArray()
    for (const note of notes) {
      let values = note.fields
      if (fieldsChanged) {
        values = edit.fields.map((f) => (f.origin != null ? (note.fields[f.origin] ?? '') : ''))
        await db.notes.update(note.id, { fields: values, searchText: noteSearchText(values, note.tags), updatedAt: now })
      }
      const cards = await db.cards.where('noteId').equals(note.id).toArray()
      if (old.kind !== 'cloze' && templatesChanged) {
        for (const c of cards) {
          const next = ordMap.get(c.ord)
          if (next == null) {
            await db.cards.delete(c.id)
            cardsRemoved++
          } else if (next !== c.ord) {
            await db.cards.update(c.id, { ord: next })
          }
        }
      }
      // New templates (or templates that now render) get cards.
      const have = new Set((await db.cards.where('noteId').equals(note.id).toArray()).map((c) => c.ord))
      const want = cardOrdinals(old.kind, templates, fields.map((f) => f.name), values)
      const deckId = cards[0]?.deckId
      const missing = want.filter((o) => !have.has(o))
      if (missing.length && deckId != null) {
        await db.cards.bulkAdd(missing.map((ord) => newCard(note.id, deckId, ord, now, now + ord) as Card))
        cardsAdded += missing.length
      }
    }
    return { cardsAdded, cardsRemoved }
  })
}

export async function cloneNoteType(sourceId: number, name: string): Promise<number> {
  const src = await db.noteTypes.get(sourceId)
  if (!src) throw new Error('Тип записи не найден')
  const now = Date.now()
  const copy = structuredClone(src) as Partial<NoteType>
  delete copy.id
  delete copy.builtin
  delete copy.ankiId
  return (await db.noteTypes.add({ ...(copy as NoteType), name, createdAt: now, updatedAt: now })) as number
}

export async function deleteNoteType(typeId: number): Promise<void> {
  const used = await db.notes.where('typeId').equals(typeId).count()
  if (used > 0) throw new Error('Этим типом пользуются записи — сначала удалите или перенесите их')
  await db.noteTypes.delete(typeId)
}
