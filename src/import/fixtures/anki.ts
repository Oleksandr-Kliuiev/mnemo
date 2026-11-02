/**
 * Builders for Anki package fixtures, used by tests only (zstd comes from node:zlib).
 * Schemas follow rslib/src/storage (schema11.sql and the schema 14–18 upgrades).
 */
import { createHash } from 'node:crypto'
import { constants, zstdCompressSync } from 'node:zlib'
import { strToU8, zipSync, type Zippable } from 'fflate'
import type { Database } from 'sql.js'
import { dayIndex, dayStart } from '../../sched/day'
import { loadSqlJs } from '../sqljs'

export interface FxField {
  name: string
  sticky?: boolean
}
export interface FxTemplate {
  name: string
  qfmt: string
  afmt: string
}
export interface FxNoteType {
  id: number
  name: string
  type: 0 | 1
  mod: number
  sortf?: number
  css: string
  fields: FxField[]
  templates: FxTemplate[]
}
export interface FxDeck {
  id: number
  name: string
  dyn?: boolean
  desc?: string
}
export interface FxNote {
  id: number
  guid: string
  mid: number
  mod: number
  tags?: string
  fields: string[]
}
export interface FxCard {
  id: number
  nid: number
  did: number
  ord?: number
  type?: number
  queue?: number
  due?: number
  ivl?: number
  factor?: number
  reps?: number
  lapses?: number
  left?: number
  odue?: number
  odid?: number
  flags?: number
  data?: string
}
export interface FxRevlog {
  id: number
  cid: number
  ease: number
  ivl: number
  lastIvl?: number
  factor?: number
  time?: number
  type: number
}
export interface FxCollection {
  crt: number
  noteTypes: FxNoteType[]
  decks: FxDeck[]
  notes: FxNote[]
  cards: FxCard[]
  revlog: FxRevlog[]
}
export interface FxMedia {
  name: string
  data: Uint8Array
}

// ── Protobuf / zstd ───────────────────────────────────────────────────────────

type PbValue = number | boolean | string | Uint8Array | undefined

/** Encode a message from [field number, value] pairs: numbers/booleans as varints, the rest length-delimited. */
export function pb(fields: [number, PbValue][]): Uint8Array {
  const out: number[] = []
  const varint = (value: number) => {
    let n = value
    while (n >= 0x80) {
      out.push((n % 0x80) | 0x80)
      n = Math.floor(n / 0x80)
    }
    out.push(n)
  }
  for (const [field, value] of fields) {
    if (value === undefined) continue
    if (typeof value === 'number' || typeof value === 'boolean') {
      varint(field * 8)
      varint(Number(value))
    } else {
      const bytes = typeof value === 'string' ? strToU8(value) : value
      varint(field * 8 + 2)
      varint(bytes.length)
      for (const b of bytes) out.push(b)
    }
  }
  return new Uint8Array(out)
}

export function zstd(data: Uint8Array, contentSize = true): Uint8Array {
  const opts = contentSize ? {} : { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } }
  return new Uint8Array(zstdCompressSync(data, opts))
}

// ── SQLite collections ────────────────────────────────────────────────────────

const V11_TABLES = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`

// "collate nocase" stands in for Anki's "collate unicase" (sql.js cannot create tables with it); the
// schema text is switched to unicase right before export, so the file looks like a real one.
const V18_TABLES = `${V11_TABLES}
CREATE TABLE graves (oid integer not null, type integer not null, usn integer not null, primary key (oid, type)) without rowid;
CREATE TABLE deck_config (id integer primary key not null, name text not null collate nocase, mtime_secs integer not null, usn integer not null, config blob not null);
CREATE TABLE config (KEY text not null primary key, usn integer not null, mtime_secs integer not null, val blob not null) without rowid;
CREATE TABLE tags (tag text not null primary key collate nocase, usn integer not null, collapsed boolean not null, config blob null) without rowid;
CREATE TABLE fields (ntid integer not null, ord integer not null, name text not null collate nocase, config blob not null, primary key (ntid, ord)) without rowid;
CREATE UNIQUE INDEX idx_fields_name_ntid ON fields (name, ntid);
CREATE TABLE templates (ntid integer not null, ord integer not null, name text not null collate nocase, mtime_secs integer not null, usn integer not null, config blob not null, primary key (ntid, ord)) without rowid;
CREATE UNIQUE INDEX idx_templates_name_ntid ON templates (name, ntid);
CREATE INDEX idx_templates_usn ON templates (usn);
CREATE TABLE notetypes (id integer not null primary key, name text not null collate nocase, mtime_secs integer not null, usn integer not null, config blob not null);
CREATE UNIQUE INDEX idx_notetypes_name ON notetypes (name);
CREATE INDEX idx_notetypes_usn ON notetypes (usn);
CREATE TABLE decks (id integer primary key not null, name text not null collate nocase, mtime_secs integer not null, usn integer not null, common blob not null, kind blob not null);
CREATE UNIQUE INDEX idx_decks_name ON decks (name);
`

async function newDb(ddl: string): Promise<Database> {
  const SQL = await loadSqlJs()
  const d = new SQL.Database()
  d.exec(ddl)
  return d
}

function insertNotesCardsRevlog(d: Database, col: FxCollection): void {
  for (const n of col.notes) {
    d.run("INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, 0, 0, '')", [
      n.id,
      n.guid,
      n.mid,
      n.mod,
      n.tags ?? '',
      n.fields.join('\x1f'),
      n.fields[0] ?? '',
    ])
  }
  for (const c of col.cards) {
    d.run('INSERT INTO cards VALUES (?, ?, ?, ?, 0, -1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      c.id,
      c.nid,
      c.did,
      c.ord ?? 0,
      c.type ?? 0,
      c.queue ?? 0,
      c.due ?? 0,
      c.ivl ?? 0,
      c.factor ?? 0,
      c.reps ?? 0,
      c.lapses ?? 0,
      c.left ?? 0,
      c.odue ?? 0,
      c.odid ?? 0,
      c.flags ?? 0,
      c.data ?? '',
    ])
  }
  for (const r of col.revlog) {
    d.run('INSERT INTO revlog VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?)', [r.id, r.cid, r.ease, r.ivl, r.lastIvl ?? 0, r.factor ?? 0, r.time ?? 1000, r.type])
  }
}

/** Schema 11: note types and decks as JSON in `col` (collection.anki2 / collection.anki21). */
export async function buildV11(col: FxCollection): Promise<Uint8Array> {
  const d = await newDb(V11_TABLES)
  const models = Object.fromEntries(
    col.noteTypes.map((m) => [
      String(m.id),
      {
        id: m.id,
        name: m.name,
        type: m.type,
        mod: m.mod,
        usn: -1,
        sortf: m.sortf ?? 0,
        did: 1,
        // Listed out of order on purpose: the importer must sort by "ord".
        tmpls: m.templates.map((t, ord) => ({ name: t.name, ord, qfmt: t.qfmt, afmt: t.afmt, bqfmt: '', bafmt: '', did: null })).reverse(),
        flds: m.fields.map((f, ord) => ({ name: f.name, ord, sticky: !!f.sticky, rtl: false, font: 'Arial', size: 20, media: [] })).reverse(),
        css: m.css,
        latexPre: '\\documentclass[12pt]{article}',
        latexPost: '\\end{document}',
        req: [[0, 'any', [0]]],
        tags: [],
        vers: [],
      },
    ]),
  )
  const decks = Object.fromEntries(
    col.decks.map((dk) => [
      String(dk.id),
      { id: dk.id, name: dk.name, dyn: dk.dyn ? 1 : 0, desc: dk.desc ?? '', mod: 0, usn: -1, collapsed: false, conf: 1, newToday: [0, 0] },
    ]),
  )
  d.run("INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, '{}', ?, ?, '{}', '{}')", [
    col.crt,
    col.crt * 1000,
    col.crt * 1000,
    JSON.stringify(models),
    JSON.stringify(decks),
  ])
  insertNotesCardsRevlog(d, col)
  const bytes = d.export()
  d.close()
  return bytes
}

/** Schema 18 (collection.anki21b before compression): note types and decks in tables with protobuf configs. */
export async function buildV18(col: FxCollection): Promise<Uint8Array> {
  const d = await newDb(V18_TABLES)
  d.run("INSERT INTO col VALUES (1, ?, ?, ?, 18, 0, 0, 0, '', '', '', '', '')", [col.crt, col.crt * 1000, col.crt * 1000])
  for (const m of col.noteTypes) {
    // Notetype.Config { kind = 1; sort_field_idx = 2; css = 3; latex_pre = 5; original_stock_kind = 9 }
    const config = pb([
      [1, m.type],
      [2, m.sortf ?? 0],
      [3, m.css],
      [5, '\\documentclass[12pt]{article}'],
      [9, m.type === 1 ? 5 : 1],
    ])
    d.run('INSERT INTO notetypes VALUES (?, ?, ?, -1, ?)', [m.id, m.name, m.mod, config])
    m.fields.forEach((f, ord) => {
      // Field.Config { sticky = 1; font_name = 3; font_size = 4 }
      d.run('INSERT INTO fields VALUES (?, ?, ?, ?)', [m.id, ord, f.name, pb([[1, !!f.sticky], [3, 'Arial'], [4, 20]])])
    })
    m.templates.forEach((t, ord) => {
      // Template.Config { q_format = 1; a_format = 2; q_format_browser = 3 }
      d.run('INSERT INTO templates VALUES (?, ?, ?, ?, -1, ?)', [m.id, ord, t.name, m.mod, pb([[1, t.qfmt], [2, t.afmt], [3, '']])])
    })
  }
  for (const dk of col.decks) {
    // Deck.KindContainer { Normal normal = 1 { config_id = 1; description = 4 }; Filtered filtered = 2 }
    const kind = dk.dyn
      ? pb([[2, pb([[1, true], [2, pb([[1, 'deck:Parent'], [2, 100]])]])]])
      : pb([[1, pb([[1, 1], [4, dk.desc]])]])
    d.run('INSERT INTO decks VALUES (?, ?, 0, -1, ?, ?)', [dk.id, dk.name.split('::').join('\x1f'), pb([[1, false]]), kind])
  }
  d.run("INSERT INTO tags VALUES ('greeting', -1, 0, NULL)")
  insertNotesCardsRevlog(d, col)
  useUnicase(d)
  const bytes = d.export()
  d.close()
  return bytes
}

function useUnicase(d: Database): void {
  const rows = d.exec("SELECT type, name, sql FROM sqlite_master WHERE sql LIKE '%collate nocase%'")[0]?.values ?? []
  d.run('PRAGMA writable_schema = ON')
  for (const [type, name, sql] of rows) {
    d.run('UPDATE sqlite_master SET sql = ? WHERE type = ? AND name = ?', [String(sql).replaceAll('collate nocase', 'collate unicase'), type, name])
  }
  d.run('PRAGMA writable_schema = RESET')
}

/** The collection.anki2 that latest packages carry for old clients. */
export async function stubCollection(): Promise<Uint8Array> {
  return buildV11({
    crt: 1_700_000_000,
    noteTypes: [
      { id: 1_500_000_000_001, name: 'Basic', type: 0, mod: 1_700_000_000, css: '', fields: [{ name: 'Front' }, { name: 'Back' }], templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{Back}}' }] },
    ],
    decks: [{ id: 1, name: 'Default' }],
    notes: [
      {
        id: 1_500_000_000_101,
        guid: 'stub-note',
        mid: 1_500_000_000_001,
        mod: 1_700_000_000,
        fields: ['Please update to the latest Anki version, then import the .colpkg/.apkg file again.', ''],
      },
    ],
    cards: [{ id: 1_500_000_000_201, nid: 1_500_000_000_101, did: 1 }],
    revlog: [],
  })
}

// ── Packages ──────────────────────────────────────────────────────────────────

export interface LegacyOptions {
  file?: 'collection.anki2' | 'collection.anki21'
  /** Add a `meta` entry, as Anki ≥ 2.1.50 does with "support older versions" on. */
  meta?: boolean
  /** Also add the stub collection.anki2 (only meaningful with file = collection.anki21). */
  stub?: boolean
}

export async function legacyPackage(col: FxCollection, media: FxMedia[], opts: LegacyOptions = {}): Promise<Uint8Array> {
  const file = opts.file ?? 'collection.anki2'
  const entries: Zippable = { [file]: await buildV11(col) }
  if (opts.meta) entries.meta = [pb([[1, file === 'collection.anki21' ? 2 : 1]]), { level: 0 }]
  if (opts.stub) entries['collection.anki2'] = await stubCollection()
  entries.media = strToU8(JSON.stringify(Object.fromEntries(media.map((m, i) => [String(i), m.name]))))
  media.forEach((m, i) => (entries[String(i)] = m.data))
  return zipSync(entries)
}

export async function latestPackage(col: FxCollection, media: FxMedia[], opts: { contentSize?: boolean; version?: number } = {}): Promise<Uint8Array> {
  const cs = opts.contentSize ?? true
  const sha1 = (data: Uint8Array) => new Uint8Array(createHash('sha1').update(data).digest())
  // MediaEntries { repeated MediaEntry entries = 1 }, MediaEntry { name = 1; size = 2; sha1 = 3 }
  const mediaList = pb(media.map((m): [number, PbValue] => [1, pb([[1, m.name], [2, m.data.length], [3, sha1(m.data)]])]))
  const entries: Zippable = {
    meta: [pb([[1, opts.version ?? 3]]), { level: 0 }],
    'collection.anki21b': [zstd(await buildV18(col), cs), { level: 0 }],
    'collection.anki2': [await stubCollection(), { level: 0 }],
    media: [zstd(mediaList, cs), { level: 0 }],
  }
  media.forEach((m, i) => (entries[String(i)] = [zstd(m.data, cs), { level: 0 }]))
  return zipSync(entries)
}

// ── Sample content ────────────────────────────────────────────────────────────

export const BASIC_ID = 1_600_000_000_001
export const CLOZE_ID = 1_600_000_000_002
export const UNUSED_ID = 1_600_000_000_003
export const DECK = { default: 1, parent: 1_700_000_000_011, child: 1_700_000_000_012, filtered: 1_700_000_000_013, empty: 1_700_000_000_014 }
export const NOTE_MOD = 1_700_000_000
const HOUR = 3_600_000

export const BASIC_TEMPLATES: FxTemplate[] = [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' }]
export const BASIC_CSS = '@font-face { font-family: Custom; src: url("_font.ttf"); }\n.card { font-family: Custom; font-size: 20px; }'
export const CLOZE_TEMPLATES: FxTemplate[] = [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}' }]

export const MEDIA: FxMedia[] = [
  { name: 'cat.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]) },
  { name: 'meow.mp3', data: new Uint8Array([0x49, 0x44, 0x33, 3, 0, 9, 8, 7]) },
  { name: '_font.ttf', data: new Uint8Array([0, 1, 0, 0, 0, 0x0e, 0x80]) },
]

/** Study-day helpers shared by the fixture and the tests (Mnemo day numbering, cutoff 4). */
export function sampleClock(now: number) {
  const crt = Math.floor(new Date(2024, 0, 15, 4, 0, 0).getTime() / 1000)
  const today = dayIndex(now, 4)
  const crtDay = dayIndex(crt * 1000 + 12 * HOUR, 4)
  /** Anki due number (days since crt) for a Mnemo study day. */
  const ankiDay = (day: number) => day - crtDay
  /** Local noon (+ minutes) of the given study day. */
  const at = (day: number, minutes = 0) => dayStart(day, 4) + 8 * HOUR + minutes * 60_000
  return { crt, today, crtDay, ankiDay, at }
}

export const NID = { review: 101, media: 102, suspended: 103, learning: 104, cloze: 105, fsrs: 106, relearn: 107, interday: 108 } as const
export const CID = { review: 201, media: 202, suspended: 203, learning: 204, cloze1: 205, cloze2: 206, fsrs: 207, relearn: 208, interday: 209 } as const
const nid = (n: number) => 1_700_000_000_000 + n
const cid = (n: number) => 1_710_000_000_000 + n
export const noteId = nid
export const cardId = cid

/**
 * 8 notes / 9 cards: review card with a review log, new card with an image and a sound, suspended,
 * flagged learning card, cloze note (one card in a filtered deck), FSRS card, relearning card and
 * an interday learning card. Decks: Default (empty), Parent (with description), Parent::Child,
 * Parent::Empty and a filtered deck.
 */
export function sampleCollection(now = Date.now()): FxCollection {
  const { crt, today, ankiDay, at } = sampleClock(now)
  const nowSecs = Math.floor(now / 1000)
  return {
    crt,
    noteTypes: [
      { id: BASIC_ID, name: 'Basic', type: 0, mod: 1_700_000_100, css: BASIC_CSS, fields: [{ name: 'Front' }, { name: 'Back', sticky: true }], templates: BASIC_TEMPLATES },
      { id: CLOZE_ID, name: 'Cloze', type: 1, mod: 1_700_000_200, css: '.cloze { color: blue; }', fields: [{ name: 'Text' }, { name: 'Back Extra' }], templates: CLOZE_TEMPLATES },
      { id: UNUSED_ID, name: 'Unused', type: 0, mod: 1_700_000_300, css: '', fields: [{ name: 'A' }], templates: [{ name: 'T', qfmt: '{{A}}', afmt: '{{A}}' }] },
    ],
    decks: [
      { id: DECK.default, name: 'Default' },
      { id: DECK.parent, name: 'Parent', desc: '<b>Описание</b> колоды<br>Вторая строка' },
      { id: DECK.child, name: 'Parent::Child' },
      { id: DECK.filtered, name: 'Фильтр', dyn: true },
      { id: DECK.empty, name: 'Parent::Empty' },
    ],
    notes: [
      { id: nid(NID.review), guid: 'g-review', mid: BASIC_ID, mod: NOTE_MOD, tags: ' greeting english ', fields: ['Hello', 'Привет'] },
      { id: nid(NID.media), guid: 'g-media', mid: BASIC_ID, mod: NOTE_MOD, fields: ['<img src="cat.jpg">', 'Кот [sound:meow.mp3]'] },
      { id: nid(NID.suspended), guid: 'g-suspended', mid: BASIC_ID, mod: NOTE_MOD, fields: ['Suspended', 'back'] },
      { id: nid(NID.learning), guid: 'g-learning', mid: BASIC_ID, mod: NOTE_MOD, fields: ['Flagged', 'back'] },
      { id: nid(NID.cloze), guid: 'g-cloze', mid: CLOZE_ID, mod: NOTE_MOD, fields: ['{{c1::Москва}} — столица {{c2::России}}', 'География'] },
      { id: nid(NID.fsrs), guid: 'g-fsrs', mid: BASIC_ID, mod: NOTE_MOD, fields: ['FSRS', 'back'] },
      { id: nid(NID.relearn), guid: 'g-relearn', mid: BASIC_ID, mod: NOTE_MOD, fields: ['Relearn', 'back'] },
      { id: nid(NID.interday), guid: 'g-interday', mid: BASIC_ID, mod: NOTE_MOD, fields: ['Interday', 'back'] },
    ],
    cards: [
      { id: cid(CID.review), nid: nid(NID.review), did: DECK.parent, type: 2, queue: 2, due: ankiDay(today + 3), ivl: 10, factor: 2300, reps: 6, lapses: 1 },
      { id: cid(CID.media), nid: nid(NID.media), did: DECK.child, due: 7 },
      { id: cid(CID.suspended), nid: nid(NID.suspended), did: DECK.child, queue: -1, due: 3 },
      { id: cid(CID.learning), nid: nid(NID.learning), did: DECK.parent, type: 1, queue: 1, due: nowSecs + 600, left: 1001, reps: 1, flags: 3 | 8 },
      { id: cid(CID.cloze1), nid: nid(NID.cloze), did: DECK.filtered, ord: 0, due: -100_000, odid: DECK.child, odue: 5 },
      { id: cid(CID.cloze2), nid: nid(NID.cloze), did: DECK.child, ord: 1, due: 5 },
      {
        id: cid(CID.fsrs),
        nid: nid(NID.fsrs),
        did: DECK.parent,
        type: 2,
        queue: 2,
        due: ankiDay(today + 10),
        ivl: 20,
        factor: 2500,
        reps: 3,
        data: JSON.stringify({ s: 25.5, d: 4.2, dr: 0.9, lrt: Math.floor(at(today - 10) / 1000), pos: 1 }),
      },
      { id: cid(CID.relearn), nid: nid(NID.relearn), did: DECK.parent, type: 3, queue: 1, due: nowSecs - 120, ivl: 2, factor: 2100, left: 1, reps: 9, lapses: 3 },
      { id: cid(CID.interday), nid: nid(NID.interday), did: DECK.child, type: 1, queue: 3, due: ankiDay(today + 1), left: 1, reps: 2 },
    ],
    revlog: [
      { id: at(today - 40), cid: cid(CID.review), ease: 3, ivl: -600, lastIvl: 0, factor: 0, time: 6000, type: 0 },
      { id: at(today - 40, 10), cid: cid(CID.review), ease: 3, ivl: 1, lastIvl: -600, factor: 2500, time: 4000, type: 0 },
      { id: at(today - 39), cid: cid(CID.review), ease: 3, ivl: 4, lastIvl: 1, factor: 2500, time: 3000, type: 1 },
      { id: at(today - 35), cid: cid(CID.review), ease: 1, ivl: -600, lastIvl: 4, factor: 2300, time: 8000, type: 1 },
      { id: at(today - 35, 10), cid: cid(CID.review), ease: 3, ivl: 1, lastIvl: -600, factor: 2300, time: 2000, type: 2 },
      // Cramming in a filtered deck without rescheduling, and a manual "set due date": not reviews.
      { id: at(today - 34), cid: cid(CID.review), ease: 3, ivl: 0, lastIvl: 0, factor: 0, time: 1000, type: 3 },
      { id: at(today - 33), cid: cid(CID.review), ease: 0, ivl: 10, lastIvl: 1, factor: 2300, time: 0, type: 4 },
      { id: at(today - 7), cid: cid(CID.review), ease: 3, ivl: 10, lastIvl: 1, factor: 2300, time: 400_000, type: 1 },
      { id: now - 60_000, cid: cid(CID.learning), ease: 3, ivl: -600, lastIvl: 0, factor: 0, time: 5000, type: 0 },
    ],
  }
}
