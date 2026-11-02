import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { default_w } from 'ts-fsrs'
import { db } from '../db/db'
import { ensureBuiltins } from '../db/repo'
import { CardState, type Card, type NoteType } from '../db/types'
import { dayIndex, dayStart } from '../sched/day'
import { memoryFromSm2 } from '../sched/fsrs'
import { importApkg, inspectApkg, type ApkgImportOptions } from './apkg'
import {
  BASIC_CSS,
  BASIC_ID,
  BASIC_TEMPLATES,
  CID,
  CLOZE_ID,
  CLOZE_TEMPLATES,
  DECK,
  MEDIA,
  NOTE_MOD,
  UNUSED_ID,
  buildV11,
  buildV18,
  cardId,
  latestPackage,
  legacyPackage,
  noteId,
  pb,
  sampleClock,
  sampleCollection,
  stubCollection,
  zstd,
  type FxCollection,
} from './fixtures/anki'

// jsdom Blobs lose their bytes inside fake-indexeddb, so keep what the importer stores.
const storedMedia = vi.hoisted(() => new Map<string, Uint8Array>())
vi.mock('../db/media', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../db/media')>()
  return {
    ...mod,
    putMediaFile: async (name: string, data: Blob | Uint8Array) => {
      if (data instanceof Uint8Array) storedMedia.set(name, data)
      await mod.putMediaFile(name, data)
    },
  }
})

const CORRUPT = /^Файл повреждён или это не колода Anki$/
const KEEP: ApkgImportOptions = { keepScheduling: true }
const RESET: ApkgImportOptions = { keepScheduling: false }

const blob = (bytes: Uint8Array) => new Blob([bytes as BlobPart])

async function reset() {
  await db.delete()
  await db.open()
  await ensureBuiltins()
  storedMedia.clear()
}

async function cardsOf(guid: string): Promise<Card[]> {
  const note = await db.notes.where('guid').equals(guid).first()
  if (!note) throw new Error(`note ${guid} not imported`)
  return (await db.cards.where('noteId').equals(note.id).toArray()).sort((a, b) => a.ord - b.ord)
}

async function cardOf(guid: string): Promise<Card> {
  return (await cardsOf(guid))[0]
}

async function deckIdOf(name: string): Promise<number> {
  const deck = await db.decks.where('name').equals(name).first()
  if (!deck) throw new Error(`deck ${name} missing`)
  return deck.id
}

async function typeByAnkiId(id: number): Promise<NoteType | undefined> {
  return db.noteTypes.where('ankiId').equals(id).first()
}

const variants = [
  ['collection.anki2 (legacy, no meta)', 'anki2', () => legacyPackage(sampleCollection(), MEDIA)],
  ['collection.anki21 (meta v2, with stub)', 'anki21', () => legacyPackage(sampleCollection(), MEDIA, { file: 'collection.anki21', meta: true, stub: true })],
  ['collection.anki21b (zstd, schema 18)', 'anki21b', () => latestPackage(sampleCollection(), MEDIA)],
] as const

describe('inspectApkg', () => {
  beforeEach(reset)

  it.each(variants)('reads %s', async (_name, format, build) => {
    const info = await inspectApkg(blob(await build()))
    expect(info).toEqual({
      format,
      notes: 8,
      cards: 9,
      decks: ['Parent', 'Parent::Child', 'Parent::Empty'],
      noteTypes: ['Basic', 'Cloze'],
      mediaCount: 3,
      hasScheduling: true,
    })
    // Inspecting writes nothing.
    expect(await db.notes.count()).toBe(0)
    expect(await db.decks.count()).toBe(0)
  })

  it('reports packages without scheduling', async () => {
    const col = sampleCollection()
    col.cards = col.cards.map((c) => ({ ...c, type: 0, queue: 0, due: 1 }))
    const info = await inspectApkg(blob(await legacyPackage(col, [])))
    expect(info.hasScheduling).toBe(false)
    expect(info.mediaCount).toBe(0)
  })
})

describe.each(variants)('importApkg: %s', (_name, _format, build) => {
  beforeEach(reset)

  it('creates decks, note types, notes, cards and media', async () => {
    const res = await importApkg(blob(await build()), KEEP)
    expect(res).toEqual({
      notesAdded: 8,
      notesUpdated: 0,
      notesSkipped: 0,
      cardsAdded: 9,
      decks: ['Parent', 'Parent::Child', 'Parent::Empty'],
      noteTypesAdded: 2,
      media: 3,
      reviewsImported: 7,
      warnings: [],
    })

    const decks = await db.decks.toArray()
    // No empty Default deck, no filtered deck.
    expect(decks.map((d) => d.name).sort()).toEqual(['Parent', 'Parent::Child', 'Parent::Empty'])
    expect(decks.find((d) => d.name === 'Parent')?.description).toBe('Описание колоды\nВторая строка')

    const basic = await typeByAnkiId(BASIC_ID)
    expect(basic).toMatchObject({
      name: 'Basic',
      kind: 'standard',
      fields: [{ name: 'Front' }, { name: 'Back', sticky: true }],
      templates: BASIC_TEMPLATES,
      css: BASIC_CSS,
      sortField: 0,
    })
    const cloze = await typeByAnkiId(CLOZE_ID)
    expect(cloze).toMatchObject({ name: 'Cloze', kind: 'cloze', fields: [{ name: 'Text' }, { name: 'Back Extra' }], templates: CLOZE_TEMPLATES })
    expect(await typeByAnkiId(UNUSED_ID)).toBeUndefined()

    const note = await db.notes.where('guid').equals('g-review').first()
    expect(note).toMatchObject({
      typeId: basic!.id,
      fields: ['Hello', 'Привет'],
      tags: ['greeting', 'english'],
      createdAt: noteId(101),
      updatedAt: NOTE_MOD * 1000,
    })
    expect(note!.searchText).toContain('hello')
    expect((await db.notes.where('guid').equals('g-media').first())!.fields).toEqual(['<img src="cat.jpg">', 'Кот [sound:meow.mp3]'])
    // The stub collection.anki2 of new packages is never read.
    expect(await db.notes.where('guid').equals('stub-note').count()).toBe(0)

    const media = await db.media.toArray()
    expect(media.map((m) => m.name).sort()).toEqual(['_font.ttf', 'cat.jpg', 'meow.mp3'])
    expect(media.find((m) => m.name === 'cat.jpg')).toMatchObject({ type: 'image/jpeg', size: MEDIA[0].data.length })
    for (const m of MEDIA) expect(storedMedia.get(m.name)).toEqual(m.data)
  })

  it('maps cloze ordinals and returns filtered cards to their home deck', async () => {
    await importApkg(blob(await build()), KEEP)
    const child = await deckIdOf('Parent::Child')
    const cards = await cardsOf('g-cloze')
    expect(cards.map((c) => c.ord)).toEqual([0, 1])
    expect(cards.map((c) => c.deckId)).toEqual([child, child])
    expect(cards.every((c) => c.state === CardState.New)).toBe(true)
  })

  it('keeps review state, flags, suspension and the review log', async () => {
    const before = Date.now()
    await importApkg(blob(await build()), KEEP)
    const { today, at } = sampleClock(before)
    const parent = await deckIdOf('Parent')

    const review = await cardOf('g-review')
    const sm2 = memoryFromSm2(2.3, 10)
    expect(review).toMatchObject({
      deckId: parent,
      state: CardState.Review,
      due: dayStart(today + 3, 4),
      scheduledDays: 10,
      reps: 6,
      lapses: 1,
      lastReview: at(today - 7),
      createdAt: cardId(CID.review),
    })
    expect(review.stability).toBeCloseTo(sm2.stability, 6)
    expect(review.difficulty).toBeCloseTo(sm2.difficulty, 6)

    const fsrs = await cardOf('g-fsrs')
    expect(fsrs).toMatchObject({ state: CardState.Review, stability: 25.5, difficulty: 4.2, scheduledDays: 20, due: dayStart(today + 10, 4) })
    expect(fsrs.lastReview).toBe(Math.floor(at(today - 10) / 1000) * 1000)

    const nowSecs = Math.floor(before / 1000)
    const learning = await cardOf('g-learning')
    expect(learning).toMatchObject({ state: CardState.Learning, flag: 3, learningSteps: 1, reps: 1, suspended: 0 })
    expect(Math.abs(learning.due - (nowSecs + 600) * 1000)).toBeLessThanOrEqual(1000)
    expect(learning.stability).toBeCloseTo(Math.max(default_w[2], 0.1), 6)
    expect(learning.difficulty).toBeGreaterThanOrEqual(1)
    expect(learning.difficulty).toBeLessThanOrEqual(10)

    const relearn = await cardOf('g-relearn')
    expect(relearn).toMatchObject({ state: CardState.Relearning, learningSteps: 0, lapses: 3, reps: 9 })
    expect(relearn.stability).toBeCloseTo(memoryFromSm2(2.1, 2).stability, 6)
    expect(relearn.lastReview).toBe(relearn.due)

    const interday = await cardOf('g-interday')
    expect(interday).toMatchObject({ state: CardState.Learning, due: dayStart(today + 1, 4) })

    expect((await cardOf('g-suspended')).suspended).toBe(1)

    // New cards keep Anki's order (position 3, then 5 for both cloze cards, then 7).
    const fresh = (await db.cards.where('state').equals(CardState.New).toArray()).sort((a, b) => a.due - b.due || a.ord - b.ord)
    const order = await Promise.all(fresh.map(async (c) => `${(await db.notes.get(c.noteId))!.guid}:${c.ord}`))
    expect(order).toEqual(['g-suspended:0', 'g-cloze:0', 'g-cloze:1', 'g-media:0'])

    const log = (await db.revlog.where('cardId').equals(review.id).toArray()).sort((a, b) => a.time - b.time)
    expect(log.map((r) => r.state)).toEqual([
      CardState.New,
      CardState.Learning,
      CardState.Review,
      CardState.Review,
      CardState.Relearning,
      CardState.Review,
    ])
    expect(log.map((r) => r.rating)).toEqual([3, 3, 3, 1, 3, 3])
    expect(log.map((r) => r.scheduledDays)).toEqual([0, 1, 4, 0, 1, 10])
    expect(log.map((r) => r.elapsedDays)).toEqual([0, 0, 1, 4, 0, 28])
    expect(log.map((r) => r.day)).toEqual([today - 40, today - 40, today - 39, today - 35, today - 35, today - 7])
    expect(log.map((r) => r.durationMs)).toEqual([6000, 4000, 3000, 8000, 2000, 300_000])
    expect(log.every((r) => r.deckId === parent)).toBe(true)
    // The last answer carries the card's memory state.
    expect(log[5].stability).toBeCloseTo(review.stability, 6)

    const learnLog = await db.revlog.where('cardId').equals(learning.id).toArray()
    expect(learnLog).toHaveLength(1)
    expect(learnLog[0]).toMatchObject({ state: CardState.New, rating: 3, day: dayIndex(before - 60_000, 4) })
    expect(await db.revlog.count()).toBe(7)
  })

  it('turns every card into a new one without scheduling', async () => {
    const res = await importApkg(blob(await build()), RESET)
    expect(res.reviewsImported).toBe(0)
    expect(await db.revlog.count()).toBe(0)
    const cards = await db.cards.toArray()
    expect(cards).toHaveLength(9)
    for (const c of cards) {
      expect(c).toMatchObject({ state: CardState.New, reps: 0, lapses: 0, stability: 0, difficulty: 0, lastReview: null })
    }
    // Anki positions first (FSRS card remembers position 1), then learned cards note by note.
    cards.sort((a, b) => a.due - b.due || a.ord - b.ord)
    const order = await Promise.all(cards.map(async (c) => `${(await db.notes.get(c.noteId))!.guid}:${c.ord}`))
    expect(order).toEqual([
      'g-fsrs:0',
      'g-suspended:0',
      'g-cloze:0',
      'g-cloze:1',
      'g-media:0',
      'g-review:0',
      'g-learning:0',
      'g-relearn:0',
      'g-interday:0',
    ])
    expect((await cardOf('g-suspended')).suspended).toBe(1)
    expect((await cardOf('g-learning')).flag).toBe(3)
  })

  it('skips duplicates when the same package is imported again', async () => {
    const bytes = await build()
    await importApkg(blob(bytes), KEEP)
    const counts = async () => [await db.notes.count(), await db.cards.count(), await db.revlog.count(), await db.noteTypes.count(), await db.decks.count()]
    const first = await counts()
    const again = await importApkg(blob(bytes), KEEP)
    expect(again).toMatchObject({ notesAdded: 0, notesUpdated: 0, notesSkipped: 8, cardsAdded: 0, noteTypesAdded: 0, reviewsImported: 0, warnings: [] })
    expect(await counts()).toEqual(first)
  })
})

describe('importApkg: merging', () => {
  beforeEach(reset)

  it('updates newer notes, adds new cards of existing notes and keeps notes edited in Mnemo', async () => {
    await importApkg(blob(await legacyPackage(sampleCollection(), MEDIA)), KEEP)
    const edited = await db.notes.where('guid').equals('g-media').first()
    await db.notes.update(edited!.id, { fields: ['Мой кот', 'Изменено'], updatedAt: Date.now() + 1000 })

    const col = sampleCollection()
    const bump = (guid: string, fields?: string[], tags?: string) => {
      const n = col.notes.find((x) => x.guid === guid)!
      n.mod = NOTE_MOD + 100
      if (fields) n.fields = fields
      if (tags) n.tags = tags
    }
    bump('g-review', ['Hello!', 'Привет!'], 'greeting updated')
    bump('g-media', ['Чужой кот', 'x'])
    bump('g-cloze', ['{{c1::Москва}} — столица {{c2::России}} на {{c3::Москве-реке}}', 'География'])
    col.cards.push({ id: cardId(300), nid: noteId(105), did: DECK.child, ord: 2, due: 6 })

    const res = await importApkg(blob(await legacyPackage(col, MEDIA)), KEEP)
    expect(res).toMatchObject({ notesAdded: 0, notesUpdated: 2, notesSkipped: 6, cardsAdded: 1, noteTypesAdded: 0 })
    const updated = await db.notes.where('guid').equals('g-review').first()
    expect(updated).toMatchObject({ fields: ['Hello!', 'Привет!'], tags: ['greeting', 'updated'], updatedAt: (NOTE_MOD + 100) * 1000 })
    expect(updated!.searchText).toContain('hello!')
    expect((await db.notes.where('guid').equals('g-media').first())!.fields).toEqual(['Мой кот', 'Изменено'])
    expect((await cardsOf('g-cloze')).map((c) => c.ord)).toEqual([0, 1, 2])
    // Cards that existed keep their progress.
    expect((await cardOf('g-review')).state).toBe(CardState.Review)
  })

  it('creates a separate note type when the fields changed and avoids name clashes', async () => {
    const now = Date.now()
    await db.noteTypes.add({
      name: 'Cloze',
      kind: 'cloze',
      fields: [{ name: 'Текст' }],
      templates: [{ name: 'C', qfmt: '{{cloze:Текст}}', afmt: '{{cloze:Текст}}' }],
      css: '',
      sortField: 0,
      createdAt: now,
      updatedAt: now,
    })
    await importApkg(blob(await legacyPackage(sampleCollection(), MEDIA)), KEEP)
    expect((await typeByAnkiId(CLOZE_ID))?.name).toBe('Cloze (Anki)')

    const col = sampleCollection()
    const basic = col.noteTypes.find((t) => t.id === BASIC_ID)!
    basic.fields = [...basic.fields, { name: 'Extra' }]
    for (const n of col.notes) if (n.mid === BASIC_ID) n.fields = [...n.fields, 'extra']
    col.notes.push({ id: noteId(900), guid: 'g-new', mid: BASIC_ID, mod: NOTE_MOD, fields: ['New', 'note', 'x'] })
    col.cards.push({ id: cardId(900), nid: noteId(900), did: DECK.parent, due: 9 })

    const res = await importApkg(blob(await legacyPackage(col, MEDIA)), KEEP)
    expect(res.noteTypesAdded).toBe(1)
    expect(res.notesAdded).toBe(1)
    expect(res.warnings).toEqual(['Не изменены записи, которые уже есть в Mnemo с другим типом записи: 7'])
    const types = (await db.noteTypes.where('ankiId').equals(BASIC_ID).toArray())
      .sort((a, b) => a.fields.length - b.fields.length)
      .map((t) => [t.name, t.fields.length])
    expect(types).toEqual([
      ['Basic', 2],
      ['Basic (Anki)', 3],
    ])
    const fresh = await db.notes.where('guid').equals('g-new').first()
    expect((await db.noteTypes.get(fresh!.typeId))?.name).toBe('Basic (Anki)')
  })

  it('updates the templates of a matched note type when the package is newer', async () => {
    await importApkg(blob(await legacyPackage(sampleCollection(), MEDIA)), KEEP)
    const col = sampleCollection()
    const basic = col.noteTypes.find((t) => t.id === BASIC_ID)!
    basic.mod += 1000
    basic.css = '.card { color: red; }'
    basic.templates = [{ name: 'Card 1', qfmt: '<b>{{Front}}</b>', afmt: '{{Back}}' }]
    const res = await importApkg(blob(await legacyPackage(col, MEDIA)), KEEP)
    expect(res.noteTypesAdded).toBe(0)
    expect(await typeByAnkiId(BASIC_ID)).toMatchObject({ css: '.card { color: red; }', templates: basic.templates })
  })
})

describe('importApkg: special cases', () => {
  beforeEach(reset)

  it('creates the Default deck only when cards live in it', async () => {
    const col = sampleCollection()
    col.cards.find((c) => c.id === cardId(CID.media))!.did = DECK.default
    const res = await importApkg(blob(await legacyPackage(col, MEDIA)), KEEP)
    expect(res.decks).toEqual(['Default', 'Parent', 'Parent::Child', 'Parent::Empty'])
    expect((await cardOf('g-media')).deckId).toBe(await deckIdOf('Default'))
  })

  it('reads zstd frames without a content size', async () => {
    const res = await importApkg(blob(await latestPackage(sampleCollection(), MEDIA, { contentSize: false })), KEEP)
    expect(res).toMatchObject({ notesAdded: 8, cardsAdded: 9, media: 3 })
    for (const m of MEDIA) expect(storedMedia.get(m.name)).toEqual(m.data)
  })

  it('imports a bare collection file without a zip', async () => {
    const legacy = await importApkg(blob(await buildV11(sampleCollection())), KEEP)
    expect(legacy).toMatchObject({ notesAdded: 8, cardsAdded: 9, media: 0 })
    await reset()
    const info = await inspectApkg(blob(zstd(await buildV18(sampleCollection()))))
    expect(info).toMatchObject({ format: 'anki21b', notes: 8, cards: 9, mediaCount: 0 })
  })

  it('still reads a package whose meta version is newer when the collection is readable', async () => {
    const res = await importApkg(blob(await latestPackage(sampleCollection(), MEDIA, { version: 4 })), KEEP)
    expect(res.notesAdded).toBe(8)
  })

  it('warns about scripts in templates and skips broken records', async () => {
    const col = sampleCollection()
    col.noteTypes[0].templates = [{ name: 'Card 1', qfmt: '{{Front}}<script>doSomething()</script>', afmt: '{{Back}}' }]
    col.notes.push({ id: noteId(901), guid: 'g-orphan-type', mid: 42, mod: NOTE_MOD, fields: ['a', 'b'] })
    col.cards.push({ id: cardId(901), nid: noteId(901), did: DECK.parent })
    col.cards.push({ id: cardId(902), nid: noteId(102), did: DECK.parent, ord: 5 })
    const res = await importApkg(blob(await legacyPackage(col, MEDIA)), KEEP)
    expect(res.notesAdded).toBe(8)
    expect(res.cardsAdded).toBe(9)
    expect(res.warnings).toEqual([
      'Шаблоны карточек используют JavaScript — в Mnemo скрипты не выполняются, часть оформления может не работать',
      'Пропущены записи, тип которых отсутствует в файле: 1',
      'Пропущены карточки без шаблона в типе записи: 1',
    ])
  })

  it('reports missing media files', async () => {
    const bytes = await legacyPackage(sampleCollection(), MEDIA)
    // Re-zip without entry "1" (meow.mp3) but keep it in the media list.
    const { unzipSync } = await import('fflate')
    const files = unzipSync(bytes)
    delete files['1']
    const res = await importApkg(blob(zipSync(files)), KEEP)
    expect(res.media).toBe(2)
    expect(res.warnings).toEqual(['Не найдены в архиве медиафайлы: 1'])
  })

  it('reports progress with Russian stage names', async () => {
    const calls: [string, number][] = []
    await importApkg(blob(await latestPackage(sampleCollection(), MEDIA)), { keepScheduling: true, onProgress: (s, f) => calls.push([s, f]) })
    const stages = new Set(calls.map(([s]) => s))
    for (const s of ['Чтение архива', 'Записи', 'История повторений', 'Медиафайлы', 'Готово']) expect(stages).toContain(s)
    expect(calls[0]).toEqual(['Чтение архива', 0])
    expect(calls.at(-1)).toEqual(['Готово', 1])
    for (let i = 1; i < calls.length; i++) expect(calls[i][1]).toBeGreaterThanOrEqual(calls[i - 1][1])
  })

  it('imports notes in chunks without losing any (exact multiple of the chunk size)', async () => {
    const { crt } = sampleClock(Date.now())
    const col: FxCollection = {
      crt,
      noteTypes: sampleCollection().noteTypes.slice(0, 1),
      decks: [{ id: DECK.parent, name: 'Большая' }],
      notes: [],
      cards: [],
      revlog: [],
    }
    for (let i = 0; i < 1000; i++) {
      col.notes.push({ id: noteId(10_000 + i), guid: `bulk-${i}`, mid: BASIC_ID, mod: NOTE_MOD, fields: [`q${i}`, `a${i}`] })
      col.cards.push({ id: cardId(10_000 + i), nid: noteId(10_000 + i), did: DECK.parent, due: 1000 - i })
    }
    const res = await importApkg(blob(await latestPackage(col, [])), RESET)
    expect(res).toMatchObject({ notesAdded: 1000, cardsAdded: 1000 })
    expect(await db.notes.count()).toBe(1000)
    // Anki positions run backwards here, so the last note comes first.
    const first = (await db.cards.orderBy('due').first())!
    expect((await db.notes.get(first.noteId))!.guid).toBe('bulk-999')
  }, 60_000)
})

describe('importApkg: invalid files', () => {
  beforeEach(reset)

  const garbage = new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251))
  const cases: [string, () => Promise<Uint8Array>][] = [
    ['random bytes', async () => garbage],
    ['an empty file', async () => new Uint8Array(0)],
    ['a zip without a collection', async () => zipSync({ 'readme.txt': strToU8('hello') })],
    ['a zip with a broken collection', async () => zipSync({ 'collection.anki2': garbage })],
    ['a truncated package', async () => (await legacyPackage(sampleCollection(), MEDIA)).slice(0, 3000)],
    ['an SQLite file that is not Anki', async () => {
      const { loadSqlJs } = await import('./sqljs')
      const SQL = await loadSqlJs()
      const d = new SQL.Database()
      d.run('CREATE TABLE foo (a)')
      return zipSync({ 'collection.anki2': d.export() })
    }],
    ['a latest package with a broken zstd collection', async () => zipSync({ meta: pb([[1, 3]]), 'collection.anki21b': zstd(garbage).slice(0, 20), 'collection.anki2': await stubCollection() })],
  ]

  it.each(cases)('rejects %s with a clear message', async (_name, make) => {
    const bytes = await make()
    await expect(inspectApkg(blob(bytes))).rejects.toThrow(CORRUPT)
    await expect(importApkg(blob(bytes), KEEP)).rejects.toThrow(CORRUPT)
    expect(await db.notes.count()).toBe(0)
    expect(await db.decks.count()).toBe(0)
  })

  it('asks to re-export when a newer package format cannot be read', async () => {
    const bytes = zipSync({ meta: pb([[1, 4]]), 'collection.anki21b': garbage, 'collection.anki2': await stubCollection() })
    await expect(importApkg(blob(bytes), KEEP)).rejects.toThrow(/более новой версией Anki/)
  })
})
