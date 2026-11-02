/**
 * Import of Anki packages: .apkg (deck export) and .colpkg (collection backup), Anki 2.1.x – 25.x.
 *
 * Layouts (rslib/src/import_export/package in ankitects/anki):
 * - legacy: collection.anki2 / collection.anki21 = SQLite schema 11, note types and decks as JSON in `col`;
 *   `media` = JSON {"0": "name.jpg"}; media files are zip entries "0", "1", …
 * - latest (`meta` version 3, Anki ≥ 2.1.50): collection.anki21b = zstd(SQLite schema 18) with note types
 *   and decks in their own tables (protobuf configs); `media` = zstd(protobuf MediaEntries); every media
 *   entry is zstd-compressed; the collection.anki2 next to it is a stub that asks old clients to update.
 */
import { unzipSync, type Unzipped } from 'fflate'
import { decompress as zstdDecompress } from 'fzstd'
import type { Database, SqlJsStatic, SqlValue } from 'sql.js'
import { default_w } from 'ts-fsrs'
import { db } from '../db/db'
import { putMediaFile } from '../db/media'
import { createDeck, newCard, newGuid, normalizeDeckName, noteSearchText } from '../db/repo'
import { getSettings } from '../db/settings'
import {
  CardState,
  type Card,
  type Grade,
  type Note,
  type NoteField,
  type NoteKind,
  type NoteTemplate,
  type NoteType,
  type ReviewEntry,
} from '../db/types'
import { stripHtml } from '../render/html'
import { dayIndex, dayStart } from '../sched/day'
import { memoryFromSm2, parseSteps, parseWeights } from '../sched/fsrs'
import { decodeProto, protoBool, protoHas, protoMessage, protoMessages, protoString, protoUint } from './protobuf'
import { loadSqlJs } from './sqljs'

// ── Public API ────────────────────────────────────────────────────────────────

export interface ApkgInfo {
  format: 'anki2' | 'anki21' | 'anki21b'
  notes: number
  cards: number
  /** Full names, '::' separated. */
  decks: string[]
  noteTypes: string[]
  mediaCount: number
  /** Any card that is not new. */
  hasScheduling: boolean
}

export interface ApkgImportOptions {
  /** Import review state and review log when present; otherwise all cards become new. */
  keepScheduling: boolean
  /** Stage text in Russian; fraction is the overall progress 0..1 (never decreases). */
  onProgress?: (stage: string, fraction: number) => void
}

export interface ApkgImportResult {
  notesAdded: number
  notesUpdated: number
  /** Duplicates: a note with the same guid exists and the imported one is not newer. */
  notesSkipped: number
  cardsAdded: number
  decks: string[]
  noteTypesAdded: number
  media: number
  reviewsImported: number
  /** Russian, user-facing. */
  warnings: string[]
}

/** Read a package without changing anything: counts for the confirmation screen. */
export async function inspectApkg(file: Blob): Promise<ApkgInfo> {
  try {
    const pkg = await openPackage(file)
    try {
      const col = readCollection(pkg.sql)
      const cardDecks: [number, number][] = []
      each(pkg.sql, 'SELECT DISTINCT did, odid FROM cards', (r) => cardDecks.push([int(r[0]), int(r[1])]))
      const noteTypes: string[] = []
      each(pkg.sql, 'SELECT DISTINCT mid FROM notes', (r) => {
        const nt = col.noteTypes.get(int(r[0]))
        if (nt) noteTypes.push(nt.name)
      })
      return {
        format: pkg.format,
        notes: scalar(pkg.sql, 'SELECT count(*) FROM notes'),
        cards: scalar(pkg.sql, 'SELECT count(*) FROM cards'),
        decks: planDecks(col.decks, cardDecks).names,
        noteTypes: noteTypes.sort((a, b) => a.localeCompare(b)),
        mediaCount: pkg.media.length,
        hasScheduling: scalar(pkg.sql, 'SELECT EXISTS (SELECT 1 FROM cards WHERE type != 0)') === 1,
      }
    } finally {
      pkg.sql.close()
    }
  } catch (e) {
    throw friendlyError(e)
  }
}

export async function importApkg(file: Blob, opts: ApkgImportOptions): Promise<ApkgImportResult> {
  const report = progressReporter(opts.onProgress)
  report(STAGE_READ, 0)
  let pkg: AnkiPackage | null = null
  try {
    // Unzipping and decompressing are synchronous: let the UI show the first stage before that.
    await yieldToUi()
    pkg = await openPackage(file)
    const col = readCollection(pkg.sql)
    return await runImport(pkg, col, opts.keepScheduling, report)
  } catch (e) {
    throw friendlyError(e)
  } finally {
    pkg?.sql.close()
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

const ERR_CORRUPT = 'Файл повреждён или это не колода Anki'
const ERR_READ = 'Не удалось прочитать файл. Выберите его ещё раз'
const ERR_TOO_NEW =
  'Файл создан более новой версией Anki, чем поддерживает Mnemo. Экспортируйте колоду ещё раз, включив «Поддержку старых версий Anki»'
const ERR_ENGINE = 'Не удалось загрузить модуль чтения колод Anki. Обновите страницу и попробуйте ещё раз'
const ERR_QUOTA = 'Не хватает места в хранилище браузера, чтобы импортировать колоду'
const ERR_MEMORY = 'Не хватило памяти, чтобы открыть такой большой файл. Попробуйте на другом устройстве'

/** Error whose message is ready to be shown to the user. */
class ImportError extends Error {}

function isQuotaError(e: unknown): boolean {
  const err = e as { name?: unknown; inner?: { name?: unknown } } | null
  return err?.name === 'QuotaExceededError' || err?.inner?.name === 'QuotaExceededError'
}

function isOutOfMemory(e: unknown): boolean {
  // Typed-array allocation failures (RangeError) and SQLite/wasm running out of heap.
  return e instanceof Error && /allocation failed|out of memory|invalid (typed )?array length|cannot enlarge memory|\boom\b/i.test(e.message)
}

/** Anything thrown while parsing the package means it is not a usable Anki file. */
function corrupt(e: unknown): Error {
  if (e instanceof ImportError) return e
  return new ImportError(isOutOfMemory(e) ? ERR_MEMORY : ERR_CORRUPT, { cause: e })
}

function friendlyError(e: unknown): Error {
  if (e instanceof ImportError) return e
  if (isQuotaError(e)) return new ImportError(ERR_QUOTA, { cause: e })
  if (isOutOfMemory(e)) return new ImportError(ERR_MEMORY, { cause: e })
  const detail = e instanceof Error && e.message ? `: ${e.message}` : ''
  return new ImportError(`Не удалось импортировать колоду${detail}`, { cause: e })
}

// ── Progress ──────────────────────────────────────────────────────────────────

const STAGE_READ = 'Чтение архива'
const STAGE_PREPARE = 'Колоды и типы записей'
const STAGE_NOTES = 'Записи'
const STAGE_REVLOG = 'История повторений'
const STAGE_MEDIA = 'Медиафайлы'
const STAGE_DONE = 'Готово'

type Report = (stage: string, fraction: number) => void

function progressReporter(cb: ApkgImportOptions['onProgress']): Report {
  let last = 0
  return (stage, fraction) => {
    if (!cb) return
    last = Math.max(last, Math.min(1, fraction))
    try {
      cb(stage, last)
    } catch {
      /* a failing progress handler must not break the import */
    }
  }
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// ── Bytes and SQL helpers ─────────────────────────────────────────────────────

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const SQLITE_MAGIC = Array.from('SQLite format 3\0', (c) => c.charCodeAt(0))
const ZIP_MAGIC = [0x50, 0x4b]

const utf8 = new TextDecoder()

function startsWith(data: Uint8Array | undefined, magic: readonly number[]): data is Uint8Array {
  if (!data || data.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) if (data[i] !== magic[i]) return false
  return true
}

function unzstd(data: Uint8Array): Uint8Array {
  return startsWith(data, ZSTD_MAGIC) ? zstdDecompress(data) : data
}

function int(v: SqlValue | undefined): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function str(v: SqlValue | undefined): string {
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return utf8.decode(v)
  return v == null ? '' : String(v)
}

function blob(v: SqlValue | undefined): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(0)
}

function each(sql: Database, query: string, fn: (row: SqlValue[]) => void): void {
  const stmt = sql.prepare(query)
  try {
    while (stmt.step()) fn(stmt.get())
  } finally {
    stmt.free()
  }
}

function scalar(sql: Database, query: string): number {
  const res = sql.exec(query)[0]
  return res ? int(res.values[0]?.[0]) : 0
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

// ── Package ───────────────────────────────────────────────────────────────────

type Format = ApkgInfo['format']

interface MediaRef {
  /** Original file name, referenced from card HTML. */
  name: string
  /** Zip entry holding the data. */
  zipName: string
}

interface AnkiPackage {
  format: Format
  /** The whole archive (media are extracted from it in batches); null for a bare collection file. */
  zip: Uint8Array | null
  sql: Database
  media: MediaRef[]
  warnings: string[]
}

/** Preferred first: a latest package also carries a stub collection.anki2. */
const COLLECTIONS: readonly (readonly [string, Format])[] = [
  ['collection.anki21b', 'anki21b'],
  ['collection.anki21', 'anki21'],
  ['collection.anki2', 'anki2'],
]

async function openPackage(file: Blob): Promise<AnkiPackage> {
  let data: Uint8Array
  try {
    data = new Uint8Array(await file.arrayBuffer())
  } catch (e) {
    throw isOutOfMemory(e) ? corrupt(e) : new ImportError(ERR_READ, { cause: e })
  }
  if (!startsWith(data, ZIP_MAGIC)) {
    // A bare collection file picked directly (collection.anki2 / .anki21 / .anki21b): no media.
    const name = (file as Partial<File>).name ?? ''
    const format: Format = startsWith(data, ZSTD_MAGIC) ? 'anki21b' : /\.anki21$/i.test(name) ? 'anki21' : 'anki2'
    let raw: Uint8Array
    try {
      raw = unzstd(data)
    } catch (e) {
      throw corrupt(e)
    }
    return { format, zip: null, sql: await openSql(raw), media: [], warnings: [] }
  }

  const names = new Set<string>()
  let meta: Uint8Array | undefined
  try {
    meta = unzipSync(data, {
      filter: (f) => {
        names.add(f.name)
        return f.name === 'meta'
      },
    }).meta
  } catch (e) {
    throw corrupt(e)
  }
  // PackageMetadata { Version version = 1 }: 1 = anki2, 2 = anki21, 3 = anki21b. Anki itself treats an
  // unknown version as "too new"; we still try the newest collection we find and only blame the version
  // when reading fails.
  const version = meta ? metaVersion(meta) : -1
  const tooNew = version === 0 || version > 3
  const found = COLLECTIONS.find(([n]) => names.has(n))
  if (!found || (version === 3 && found[1] !== 'anki21b')) throw new ImportError(tooNew ? ERR_TOO_NEW : ERR_CORRUPT)
  const [colName, format] = found

  let files: Unzipped
  try {
    files = unzipSync(data, { filter: (f) => f.name === colName || f.name === 'media' })
  } catch (e) {
    throw corrupt(e)
  }
  const warnings: string[] = []
  let media: MediaRef[] = []
  if (files.media) {
    try {
      media = parseMediaList(files.media, format === 'anki21b')
    } catch {
      warnings.push('Список медиафайлов в архиве повреждён — картинки и звуки не импортированы')
    }
  }
  let sql: Database
  try {
    sql = await openSql(unzstd(files[colName]))
  } catch (e) {
    if (tooNew && !(e instanceof ImportError && e.message === ERR_ENGINE)) throw new ImportError(ERR_TOO_NEW, { cause: e })
    throw corrupt(e)
  }
  return { format, zip: data, sql, media, warnings }
}

function metaVersion(meta: Uint8Array): number {
  try {
    return protoUint(decodeProto(meta), 1)
  } catch {
    return -1
  }
}

function parseMediaList(raw: Uint8Array, latest: boolean): MediaRef[] {
  const data = unzstd(raw)
  if (!data.length) return []
  const fromJson = (): MediaRef[] => {
    const map: unknown = JSON.parse(utf8.decode(data))
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new TypeError('media map')
    const out: MediaRef[] = []
    for (const [zipName, name] of Object.entries(map as Record<string, unknown>)) {
      if (typeof name === 'string' && name) out.push({ zipName, name })
    }
    return out
  }
  // MediaEntries { repeated MediaEntry entries = 1 }
  // MediaEntry { string name = 1; uint32 size = 2; bytes sha1 = 3; optional uint32 legacy_zip_filename = 255 }
  const fromProto = (): MediaRef[] => {
    const out: MediaRef[] = []
    protoMessages(decodeProto(data), 1).forEach((entry, i) => {
      const name = protoString(entry, 1)
      if (name) out.push({ name, zipName: String(protoHas(entry, 255) ? protoUint(entry, 255) : i) })
    })
    return out
  }
  try {
    return latest ? fromProto() : fromJson()
  } catch {
    return latest ? fromJson() : fromProto()
  }
}

async function openSql(data: Uint8Array): Promise<Database> {
  if (!startsWith(data, SQLITE_MAGIC)) throw new ImportError(ERR_CORRUPT)
  let SQL: SqlJsStatic
  try {
    SQL = await loadSqlJs()
  } catch (e) {
    throw new ImportError(ERR_ENGINE, { cause: e })
  }
  const sql = new SQL.Database(data)
  try {
    sql.exec('SELECT count(*) FROM sqlite_master')
    replaceUnicase(sql)
  } catch (e) {
    sql.close()
    throw corrupt(e)
  }
  return sql
}

/**
 * Schema 18 declares Anki's own "unicase" collation on name columns. sql.js does not have it, and even
 * a plain scan of a WITHOUT ROWID table using it (fields, templates) fails. Reading never compares by
 * name, so the schema is switched to NOCASE in memory.
 */
function replaceUnicase(sql: Database): void {
  const res = sql.exec("SELECT type, name, sql FROM sqlite_master WHERE sql LIKE '%unicase%'")[0]
  if (!res) return
  sql.run('PRAGMA writable_schema = ON')
  try {
    for (const [type, name, text] of res.values) {
      sql.run('UPDATE sqlite_master SET sql = ? WHERE type = ? AND name = ?', [
        str(text).replace(/\bcollate\s+unicase\b/gi, 'COLLATE NOCASE'),
        str(type),
        str(name),
      ])
    }
  } finally {
    // Turns schema writing off again and reloads the schema.
    sql.run('PRAGMA writable_schema = RESET')
  }
}

// ── Collection: note types and decks ──────────────────────────────────────────

interface AnkiNoteType {
  id: number
  name: string
  kind: NoteKind
  fields: NoteField[]
  templates: NoteTemplate[]
  css: string
  sortField: number
  mtimeMs: number
  imageOcclusion: boolean
}

interface AnkiDeck {
  id: number
  name: string
  filtered: boolean
  description: string
}

interface AnkiCollection {
  /** Collection creation, epoch seconds; review due dates count days from it. */
  crt: number
  tables: Set<string>
  noteTypes: Map<number, AnkiNoteType>
  decks: Map<number, AnkiDeck>
}

/** StockNotetype.OriginalStockKind: 6 = image occlusion (Anki 23.10+). */
const STOCK_IMAGE_OCCLUSION = 6

function readCollection(sql: Database): AnkiCollection {
  try {
    const tables = new Set<string>()
    each(sql, "SELECT name FROM sqlite_master WHERE type = 'table'", (r) => tables.add(str(r[0])))
    if (!tables.has('col') || !tables.has('notes') || !tables.has('cards')) throw new ImportError(ERR_CORRUPT)
    const col = sql.exec('SELECT * FROM col LIMIT 1')[0]
    if (!col?.values.length) throw new ImportError(ERR_CORRUPT)
    const colValue = (name: string): SqlValue | undefined => col.values[0][col.columns.indexOf(name)]
    // Schema ≥ 15 moved note types and decks out of the JSON columns of `col` into tables.
    return {
      crt: int(colValue('crt')),
      tables,
      noteTypes: tables.has('notetypes') ? readNoteTypesV18(sql) : readNoteTypesV11(str(colValue('models'))),
      decks: tables.has('decks') ? readDecksV18(sql) : readDecksV11(str(colValue('decks'))),
    }
  } catch (e) {
    throw corrupt(e)
  }
}

function byOrd<T extends { ord?: unknown }>(list: T[]): T[] {
  return list
    .map((item, i) => ({ item, key: Number(item.ord ?? i) }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item)
}

function isImageOcclusion(stockKind: number, templates: NoteTemplate[]): boolean {
  return stockKind === STOCK_IMAGE_OCCLUSION || templates.some((t) => t.qfmt.includes('image-occlusion'))
}

interface JsonModel {
  id?: unknown
  name?: unknown
  type?: unknown
  mod?: unknown
  sortf?: unknown
  css?: unknown
  flds?: unknown
  tmpls?: unknown
  originalStockKind?: unknown
}
interface JsonField {
  name?: unknown
  ord?: unknown
  sticky?: unknown
}
interface JsonTemplate {
  name?: unknown
  ord?: unknown
  qfmt?: unknown
  afmt?: unknown
}

function readNoteTypesV11(json: string): Map<number, AnkiNoteType> {
  const out = new Map<number, AnkiNoteType>()
  const models = (json ? JSON.parse(json) : {}) as Record<string, JsonModel> | null
  for (const [key, m] of Object.entries(models ?? {})) {
    if (!m || typeof m !== 'object') continue
    const id = Number(m.id ?? key)
    const fields = byOrd((Array.isArray(m.flds) ? m.flds : []) as JsonField[]).map(
      (f): NoteField => (f.sticky === true ? { name: String(f.name ?? ''), sticky: true } : { name: String(f.name ?? '') }),
    )
    const templates = byOrd((Array.isArray(m.tmpls) ? m.tmpls : []) as JsonTemplate[]).map(
      (t): NoteTemplate => ({ name: String(t.name ?? ''), qfmt: String(t.qfmt ?? ''), afmt: String(t.afmt ?? '') }),
    )
    out.set(id, {
      id,
      name: String(m.name ?? ''),
      kind: Number(m.type) === 1 ? 'cloze' : 'standard',
      fields,
      templates,
      css: String(m.css ?? ''),
      sortField: Number(m.sortf) || 0,
      mtimeMs: (Number(m.mod) || 0) * 1000,
      imageOcclusion: isImageOcclusion(Number(m.originalStockKind), templates),
    })
  }
  return out
}

/**
 * notetypes.config = Notetype.Config { kind = 1 (0 normal, 1 cloze); sort_field_idx = 2; css = 3; original_stock_kind = 9 },
 * fields.config = Field.Config { sticky = 1 }, templates.config = Template.Config { q_format = 1; a_format = 2 }.
 */
function readNoteTypesV18(sql: Database): Map<number, AnkiNoteType> {
  const out = new Map<number, AnkiNoteType>()
  const stock = new Map<number, number>()
  each(sql, 'SELECT id, name, mtime_secs, config FROM notetypes', (r) => {
    const id = int(r[0])
    const cfg = decodeProto(blob(r[3]))
    stock.set(id, protoUint(cfg, 9))
    out.set(id, {
      id,
      name: str(r[1]),
      kind: protoUint(cfg, 1) === 1 ? 'cloze' : 'standard',
      fields: [],
      templates: [],
      css: protoString(cfg, 3),
      sortField: protoUint(cfg, 2),
      mtimeMs: int(r[2]) * 1000,
      imageOcclusion: false,
    })
  })
  each(sql, 'SELECT ntid, name, config FROM fields ORDER BY ntid, ord', (r) => {
    const nt = out.get(int(r[0]))
    if (!nt) return
    const sticky = protoBool(decodeProto(blob(r[2])), 1)
    nt.fields.push(sticky ? { name: str(r[1]), sticky } : { name: str(r[1]) })
  })
  each(sql, 'SELECT ntid, name, config FROM templates ORDER BY ntid, ord', (r) => {
    const nt = out.get(int(r[0]))
    if (!nt) return
    const cfg = decodeProto(blob(r[2]))
    nt.templates.push({ name: str(r[1]), qfmt: protoString(cfg, 1), afmt: protoString(cfg, 2) })
  })
  for (const nt of out.values()) nt.imageOcclusion = isImageOcclusion(stock.get(nt.id) ?? 0, nt.templates)
  return out
}

function deckName(raw: string): string {
  // Schema 18 separates levels with \x1f; "::" everywhere else.
  return normalizeDeckName(raw.split('\x1f').join('::')) || 'Default'
}

interface JsonDeck {
  id?: unknown
  name?: unknown
  dyn?: unknown
  desc?: unknown
}

function readDecksV11(json: string): Map<number, AnkiDeck> {
  const out = new Map<number, AnkiDeck>()
  const decks = (json ? JSON.parse(json) : {}) as Record<string, JsonDeck> | null
  for (const [key, d] of Object.entries(decks ?? {})) {
    if (!d || typeof d !== 'object') continue
    const id = Number(d.id ?? key)
    out.set(id, { id, name: deckName(String(d.name ?? '')), filtered: Number(d.dyn) > 0, description: String(d.desc ?? '') })
  }
  return out
}

/** decks.kind = Deck.KindContainer { oneof kind { Normal normal = 1; Filtered filtered = 2 } }, Normal.description = 4. */
function readDecksV18(sql: Database): Map<number, AnkiDeck> {
  const out = new Map<number, AnkiDeck>()
  each(sql, 'SELECT id, name, kind FROM decks', (r) => {
    const id = int(r[0])
    let filtered = false
    let description = ''
    try {
      const kind = decodeProto(blob(r[2]))
      filtered = protoHas(kind, 2)
      const normal = protoMessage(kind, 1)
      if (normal) description = protoString(normal, 4)
    } catch {
      /* unreadable deck settings: import as a normal deck */
    }
    out.set(id, { id, name: deckName(str(r[1])), filtered, description })
  })
  return out
}

interface DeckPlan {
  /** Decks to create, sorted (parents before children). */
  names: string[]
  /** Name of the deck a card goes to. */
  home: (did: number, odid: number) => string
  descriptions: Map<string, string>
}

function planDecks(decks: Map<number, AnkiDeck>, cardDecks: Iterable<readonly [number, number]>): DeckPlan {
  const fallback = decks.get(1)?.name ?? 'Default'
  // Cards in a filtered deck return to their home deck; filtered decks themselves are not imported
  // (one whose home deck is unknown is kept as a normal deck so its cards have somewhere to go).
  const home = (did: number, odid: number): string => {
    const original = odid ? decks.get(odid) : undefined
    if (original && !original.filtered) return original.name
    return decks.get(did)?.name ?? fallback
  }
  const names = new Set<string>()
  for (const [did, odid] of cardDecks) names.add(home(did, odid))
  // Empty decks are kept (deck tree of a collection backup), except Anki's always-present Default deck.
  for (const d of decks.values()) if (!d.filtered && d.id !== 1) names.add(d.name)
  const descriptions = new Map<string, string>()
  for (const d of decks.values()) {
    const text = d.filtered ? '' : plainDescription(d.description)
    if (text) descriptions.set(d.name, text)
  }
  return { names: [...names].sort((a, b) => a.localeCompare(b)), home, descriptions }
}

/** Anki deck descriptions are HTML; Mnemo keeps plain text. */
function plainDescription(html: string): string {
  return stripHtml(html)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000)
}

// ── Notes and cards ───────────────────────────────────────────────────────────

interface AnkiNote {
  id: number
  guid: string
  mid: number
  mod: number
  tags: string[]
  fields: string[]
}

/** Card `data` JSON (rslib CardData): FSRS memory s/d, original new position, last review time (secs). */
interface CardData {
  s?: number
  d?: number
  pos?: number
  lrt?: number
}

interface AnkiCard {
  id: number
  nid: number
  did: number
  ord: number
  /** 0 new, 1 learning, 2 review, 3 relearning. */
  type: number
  /** -1 suspended, -2/-3 buried, 0 new, 1 learning (due = epoch secs), 2 review, 3 day learning, 4 preview. */
  queue: number
  /** New: position. Review / day learning: days since crt. Learning: epoch seconds. */
  due: number
  /** Days; negative = seconds. */
  ivl: number
  /** Ease, permille. */
  factor: number
  reps: number
  lapses: number
  /** Remaining learning steps (left % 1000). */
  left: number
  odue: number
  odid: number
  flags: number
  data: CardData
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function parseCardData(raw: string): CardData {
  if (raw.length < 3) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return {}
    const o = v as Record<string, unknown>
    return { s: finite(o.s), d: finite(o.d), pos: finite(o.pos), lrt: finite(o.lrt) }
  } catch {
    return {}
  }
}

function readCards(sql: Database): Map<number, AnkiCard[]> {
  const byNote = new Map<number, AnkiCard[]>()
  const query = 'SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards ORDER BY nid, ord, id'
  each(sql, query, (r) => {
    const c: AnkiCard = {
      id: int(r[0]),
      nid: int(r[1]),
      did: int(r[2]),
      ord: int(r[3]),
      type: int(r[4]),
      queue: int(r[5]),
      due: int(r[6]),
      ivl: int(r[7]),
      factor: int(r[8]),
      reps: int(r[9]),
      lapses: int(r[10]),
      left: int(r[11]),
      odue: int(r[12]),
      odid: int(r[13]),
      flags: int(r[14]),
      data: parseCardData(str(r[15])),
    }
    const list = byNote.get(c.nid)
    if (list) list.push(c)
    else byNote.set(c.nid, [c])
  })
  return byNote
}

interface Memory {
  stability: number
  difficulty: number
}

interface CardContext {
  keep: boolean
  now: number
  cutoff: number
  /** Study day (Mnemo numbering) of the collection's creation day. */
  crtDay: number
  learnSteps: number
  relearnSteps: number
  w: readonly number[]
  /** Anki card id → ordering key for cards that become new. */
  newDue: Map<number, number>
  /** Anki card id → epoch ms of its last real review (from the revlog). */
  lastReview: Map<number, number>
  deckOf: (c: AnkiCard) => number
}

/** Epoch seconds from 2001 on; day numbers and positions never get this large. */
const EPOCH_SECS = 1_000_000_000
const YEAR_2000_MS = 946_684_800_000
const DAY_MS = 86_400_000

function plausibleTime(ms: number, now: number): number {
  return ms >= YEAR_2000_MS && ms <= now + DAY_MS ? ms : now
}

function keepsSchedule(c: AnkiCard, keep: boolean): boolean {
  return keep && c.type >= 1 && c.type <= 3
}

/**
 * Ordering keys for cards that become new: Anki's new-card position, or the original position
 * stored when a learned card is reset. Dense ranks keep the order while staying close to `base`
 * (new-card keys in Mnemo are epoch ms of creation).
 */
function newCardOrder(cardsByNote: Map<number, AnkiCard[]>, keep: boolean, base: number): Map<number, number> {
  const pos = new Map<number, number>()
  const withoutPos: AnkiCard[][] = []
  let max = -1
  for (const cards of cardsByNote.values()) {
    let missing = false
    for (const c of cards) {
      if (keepsSchedule(c, keep)) continue
      const p = c.type === 0 ? (c.odid ? c.odue : c.due) : c.data.pos
      if (p == null) {
        missing = true
        continue
      }
      pos.set(c.id, p)
      if (p > max) max = p
    }
    if (missing) withoutPos.push(cards)
  }
  // Learned cards without a recorded position go after all others, note by note.
  let next = max + 1
  for (const cards of withoutPos) {
    for (const c of cards) if (!keepsSchedule(c, keep) && !pos.has(c.id)) pos.set(c.id, next)
    next++
  }
  const rank = new Map([...new Set(pos.values())].sort((a, b) => a - b).map((p, i) => [p, i]))
  const out = new Map<number, number>()
  for (const [id, p] of pos) out.set(id, base + (rank.get(p) ?? 0))
  return out
}

function easeOf(factor: number): number {
  return factor >= 1300 ? factor / 1000 : 2.5
}

/** FSRS memory Anki keeps in card data when FSRS was enabled (difficulty 1..10). */
function storedMemory(data: CardData): Memory | null {
  const { s, d } = data
  if (s == null || d == null || !(s > 0) || d < 1 || d > 10) return null
  return { stability: Math.min(s, 36500), difficulty: d }
}

/** Memory after a first "Good" answer of a new card (FSRS initial stability and difficulty). */
function initialMemory(w: readonly number[]): Memory {
  return { stability: Math.max(w[2], 0.1), difficulty: clamp(w[4] - Math.exp(2 * w[5]) + 1, 1, 10) }
}

/** ts-fsrs step index from Anki's remaining steps; Anki may use a different number of steps. */
function stepIndex(steps: number, left: number): number {
  if (steps <= 0) return 0
  return clamp(steps - (left % 1000), 0, steps - 1)
}

function reviewedAt(c: AnkiCard, ctx: CardContext): number | undefined {
  const lrt = c.data.lrt
  if (lrt != null && lrt > EPOCH_SECS) return lrt > 1e11 ? lrt : lrt * 1000
  return ctx.lastReview.get(c.id)
}

function buildCard(c: AnkiCard, noteId: number, ctx: CardContext): Omit<Card, 'id'> {
  const card = newCard(noteId, ctx.deckOf(c), c.ord, ctx.now, ctx.newDue.get(c.id) ?? ctx.now)
  card.createdAt = plausibleTime(c.id, ctx.now)
  card.suspended = c.queue === -1 ? 1 : 0
  card.flag = c.flags & 7
  if (!keepsSchedule(c, ctx.keep)) return card

  const due = c.odid ? c.odue : c.due
  const last = reviewedAt(c, ctx)
  card.reps = c.reps
  card.lapses = c.lapses
  let memory: Memory
  if (c.type === 2) {
    const ivl = Math.max(1, c.ivl)
    const dueDay = due > EPOCH_SECS ? dayIndex(due * 1000, ctx.cutoff) : ctx.crtDay + due
    memory = storedMemory(c.data) ?? memoryFromSm2(easeOf(c.factor), ivl, 0.9, ctx.w)
    card.state = CardState.Review
    card.due = dayStart(dueDay, ctx.cutoff)
    card.scheduledDays = ivl
    card.lastReview = Math.min(last ?? dayStart(dueDay - ivl, ctx.cutoff), ctx.now)
  } else {
    const relearn = c.type === 3
    // Intraday learning is due at an epoch second, interday learning (queue 3) on a day number.
    const dueMs = due > EPOCH_SECS ? due * 1000 : due > 0 ? dayStart(ctx.crtDay + due, ctx.cutoff) : ctx.now
    memory =
      storedMemory(c.data) ??
      (relearn ? memoryFromSm2(easeOf(c.factor), Math.max(1, c.ivl), 0.9, ctx.w) : initialMemory(ctx.w))
    card.state = relearn ? CardState.Relearning : CardState.Learning
    card.due = dueMs
    card.learningSteps = stepIndex(relearn ? ctx.relearnSteps : ctx.learnSteps, c.left)
    card.lastReview = Math.min(last ?? dueMs, ctx.now)
  }
  card.stability = memory.stability
  card.difficulty = memory.difficulty
  return card
}

function validOrd(ord: number, type: NoteType): boolean {
  return ord >= 0 && (type.kind === 'cloze' || ord < type.templates.length)
}

function sameShape(t: NoteType, a: AnkiNoteType): boolean {
  return (
    t.kind === a.kind &&
    t.fields.length === a.fields.length &&
    t.fields.every((f, i) => f.name === a.fields[i].name) &&
    (a.kind === 'cloze' || t.templates.length === a.templates.length)
  )
}

function uniqueName(base: string, taken: Set<string>): string {
  const free = (n: string) => !taken.has(n.toLowerCase())
  if (free(base)) return base
  if (free(`${base} (Anki)`)) return `${base} (Anki)`
  for (let n = 2; ; n++) if (free(`${base} (Anki ${n})`)) return `${base} (Anki ${n})`
}

/** Match note types by Anki id and field names; create the rest. Returns Anki notetype id → Mnemo type. */
async function importNoteTypes(col: AnkiCollection, mids: number[], now: number, result: ApkgImportResult): Promise<Map<number, NoteType>> {
  const existing = await db.noteTypes.toArray()
  const taken = new Set(existing.map((t) => t.name.toLowerCase()))
  const out = new Map<number, NoteType>()
  let scripts = false
  let occlusion = false
  for (const mid of mids) {
    const at = col.noteTypes.get(mid)
    if (!at) continue
    scripts ||= at.templates.some((t) => /<script/i.test(t.qfmt + t.afmt))
    occlusion ||= at.imageOcclusion
    const match = existing.find((t) => t.ankiId === at.id && sameShape(t, at))
    if (match) {
      // Like Anki's "update note types if newer": a type edited in Mnemo since then is left alone.
      if (at.mtimeMs > match.updatedAt) {
        const patch = { templates: at.templates, css: at.css, updatedAt: at.mtimeMs }
        await db.noteTypes.update(match.id, patch)
        out.set(mid, { ...match, ...patch })
      } else {
        out.set(mid, match)
      }
      continue
    }
    const name = uniqueName(at.name.trim() || 'Anki', taken)
    taken.add(name.toLowerCase())
    const created: Omit<NoteType, 'id'> = {
      name,
      kind: at.kind,
      fields: at.fields,
      templates: at.templates,
      css: at.css,
      sortField: clamp(at.sortField, 0, Math.max(0, at.fields.length - 1)),
      ankiId: at.id,
      createdAt: now,
      updatedAt: at.mtimeMs || now,
    }
    const id = (await db.noteTypes.add(created)) as number
    out.set(mid, { ...created, id })
    result.noteTypesAdded++
  }
  if (scripts) {
    result.warnings.push('Шаблоны карточек используют JavaScript — в Mnemo скрипты не выполняются, часть оформления может не работать')
  }
  if (occlusion) {
    result.warnings.push('Карточки Image Occlusion импортированы, но маски на картинках в Mnemo не отображаются')
  }
  return out
}

interface AddedCard {
  id: number
  deckId: number
  memory: Memory | null
}

interface NoteStats {
  noType: number
  noCards: number
  badOrd: number
  otherType: number
}

const NOTE_CHUNK = 500

async function importNotes(
  sql: Database,
  total: number,
  types: Map<number, NoteType>,
  cardsByNote: Map<number, AnkiCard[]>,
  ctx: CardContext,
  added: Map<number, AddedCard>,
  result: ApkgImportResult,
  onPart: (part: number) => void,
): Promise<void> {
  const stats: NoteStats = { noType: 0, noCards: 0, badOrd: 0, otherType: 0 }
  const seen = new Set<string>()
  const stmt = sql.prepare('SELECT id, guid, mid, mod, tags, flds FROM notes ORDER BY id')
  let done = 0
  try {
    for (;;) {
      const chunk: AnkiNote[] = []
      while (chunk.length < NOTE_CHUNK && stmt.step()) {
        const r = stmt.get()
        chunk.push({
          id: int(r[0]),
          guid: str(r[1]),
          mid: int(r[2]),
          mod: int(r[3]),
          tags: str(r[4]).split(/\s+/).filter(Boolean),
          fields: str(r[5]).split('\x1f'),
        })
      }
      if (chunk.length) await importNoteChunk(chunk, types, cardsByNote, ctx, added, seen, stats, result)
      done += chunk.length
      onPart(done / Math.max(1, total))
      await yieldToUi()
      // Never step a finished statement again: sql.js would restart the query.
      if (chunk.length < NOTE_CHUNK) break
    }
  } finally {
    stmt.free()
  }
  const w = result.warnings
  if (stats.noType) w.push(`Пропущены записи, тип которых отсутствует в файле: ${stats.noType}`)
  if (stats.noCards) w.push(`Пропущены записи без карточек: ${stats.noCards}`)
  if (stats.badOrd) w.push(`Пропущены карточки без шаблона в типе записи: ${stats.badOrd}`)
  if (stats.otherType) w.push(`Не изменены записи, которые уже есть в Mnemo с другим типом записи: ${stats.otherType}`)
}

async function importNoteChunk(
  chunk: AnkiNote[],
  types: Map<number, NoteType>,
  cardsByNote: Map<number, AnkiCard[]>,
  ctx: CardContext,
  added: Map<number, AddedCard>,
  seen: Set<string>,
  stats: NoteStats,
  result: ApkgImportResult,
): Promise<void> {
  const notes: AnkiNote[] = []
  for (const n of chunk) {
    n.guid ||= newGuid()
    if (!types.has(n.mid)) stats.noType++
    else if (seen.has(n.guid)) result.notesSkipped++
    else {
      seen.add(n.guid)
      notes.push(n)
    }
  }
  const existing = notes.length ? await db.notes.where('guid').anyOf(notes.map((n) => n.guid)).toArray() : []
  const byGuid = new Map(existing.map((n) => [n.guid, n]))
  const ordsOf = new Map<number, Set<number>>()
  if (existing.length) {
    for (const c of await db.cards.where('noteId').anyOf(existing.map((n) => n.id)).toArray()) {
      let set = ordsOf.get(c.noteId)
      if (!set) ordsOf.set(c.noteId, (set = new Set()))
      set.add(c.ord)
    }
  }

  const newNotes: Omit<Note, 'id'>[] = []
  const updates: Note[] = []
  // noteIndex: index into newNotes (its id is known after bulkAdd), or -1 when noteId is already set.
  const pending: { ankiId: number; noteIndex: number; card: Omit<Card, 'id'> }[] = []
  for (const n of notes) {
    const type = types.get(n.mid)!
    const fields = n.fields.length >= type.fields.length ? n.fields : [...n.fields, ...Array<string>(type.fields.length - n.fields.length).fill('')]
    const all = cardsByNote.get(n.id) ?? []
    const cards = all.filter((c) => validOrd(c.ord, type))
    stats.badOrd += all.length - cards.length
    if (!cards.length) {
      stats.noCards++
      continue
    }
    const old = byGuid.get(n.guid)
    if (old) {
      if (old.typeId !== type.id) {
        stats.otherType++
        result.notesSkipped++
        continue
      }
      if (n.mod * 1000 > old.updatedAt) {
        updates.push({ ...old, fields, tags: n.tags, searchText: noteSearchText(fields, n.tags), updatedAt: n.mod * 1000 })
        result.notesUpdated++
      } else {
        result.notesSkipped++
      }
      // Cards the note does not have yet (new cloze numbers or templates) are still added.
      const have = ordsOf.get(old.id) ?? new Set<number>()
      for (const c of cards) {
        if (have.has(c.ord)) continue
        have.add(c.ord)
        pending.push({ ankiId: c.id, noteIndex: -1, card: buildCard(c, old.id, ctx) })
      }
      continue
    }
    const noteIndex = newNotes.length
    newNotes.push({
      typeId: type.id,
      guid: n.guid,
      fields,
      tags: n.tags,
      searchText: noteSearchText(fields, n.tags),
      createdAt: plausibleTime(n.id, ctx.now),
      updatedAt: plausibleTime(n.mod * 1000, ctx.now),
    })
    result.notesAdded++
    const ords = new Set<number>()
    for (const c of cards) {
      if (ords.has(c.ord)) continue
      ords.add(c.ord)
      pending.push({ ankiId: c.id, noteIndex, card: buildCard(c, 0, ctx) })
    }
  }

  await db.transaction('rw', db.notes, db.cards, async () => {
    const noteIds = newNotes.length ? await db.notes.bulkAdd(newNotes, { allKeys: true }) : []
    for (const p of pending) if (p.noteIndex >= 0) p.card.noteId = noteIds[p.noteIndex]
    if (updates.length) await db.notes.bulkPut(updates)
    if (!pending.length) return
    const cardIds = await db.cards.bulkAdd(
      pending.map((p) => p.card),
      { allKeys: true },
    )
    pending.forEach((p, i) => {
      const c = p.card
      added.set(p.ankiId, {
        id: cardIds[i],
        deckId: c.deckId,
        memory: c.state === CardState.New ? null : { stability: c.stability, difficulty: c.difficulty },
      })
    })
  })
  result.cardsAdded += pending.length
}

// ── Review log ────────────────────────────────────────────────────────────────

/** Answers that count as reviews (rslib has_rating_and_affects_scheduling): rated and not cramming. */
const RATED_REVIEW = 'ease BETWEEN 1 AND 4 AND type BETWEEN 0 AND 3 AND NOT (type = 3 AND factor = 0)'

function lastReviews(sql: Database, tables: Set<string>): Map<number, number> {
  const out = new Map<number, number>()
  if (!tables.has('revlog')) return out
  each(sql, `SELECT cid, max(id) FROM revlog WHERE ${RATED_REVIEW} GROUP BY cid`, (r) => out.set(int(r[0]), int(r[1])))
  return out
}

/** Anki does not log memory states; estimate them from the logged interval and ease. */
function estimateMemory(factor: number, ivl: number, w: readonly number[]): Memory {
  const mem = memoryFromSm2(easeOf(factor), ivl > 0 ? ivl : -ivl / 86_400, 0.9, w)
  // With FSRS on, Anki logs difficulty instead of ease: factor = ((D − 1) / 9 + 0.1) × 1000.
  if (factor >= 100 && factor <= 1100) mem.difficulty = clamp((factor / 1000 - 0.1) * 9 + 1, 1, 10)
  return mem
}

const REVLOG_CHUNK = 2000
const MAX_DURATION_MS = 5 * 60_000

async function importRevlog(
  sql: Database,
  total: number,
  ctx: CardContext,
  added: Map<number, AddedCard>,
  result: ApkgImportResult,
  onPart: (part: number) => void,
): Promise<void> {
  const stmt = sql.prepare('SELECT id, cid, ease, ivl, factor, time, type FROM revlog ORDER BY cid, id')
  let batch: ReviewEntry[] = []
  let cid = Number.NaN
  let prevDay: number | null = null
  let fresh = true
  let done = 0
  const flush = async () => {
    if (batch.length) await db.revlog.bulkAdd(batch)
    result.reviewsImported += batch.length
    batch = []
    onPart(done / Math.max(1, total))
    await yieldToUi()
  }
  try {
    while (stmt.step()) {
      const r = stmt.get()
      done++
      const rowCid = int(r[1])
      if (rowCid !== cid) {
        cid = rowCid
        prevDay = null
        fresh = true
      }
      const target = added.get(rowCid)
      if (!target) continue
      const [id, ease, ivl, factor, time, type] = [int(r[0]), int(r[2]), int(r[3]), int(r[4]), int(r[5]), int(r[6])]
      // "Forget" (manual entry with factor 0): the next learning answer starts from a new card again.
      if (type === 4 && factor === 0) fresh = true
      if (!(ease >= 1 && ease <= 4 && type >= 0 && type <= 3) || (type === 3 && factor === 0)) continue
      const day = dayIndex(id, ctx.cutoff)
      const memory = ctx.lastReview.get(rowCid) === id && target.memory ? target.memory : estimateMemory(factor, ivl, ctx.w)
      batch.push({
        cardId: target.id,
        deckId: target.deckId,
        time: id,
        day,
        rating: ease as Grade,
        state: type === 0 ? (fresh ? CardState.New : CardState.Learning) : type === 2 ? CardState.Relearning : CardState.Review,
        stability: memory.stability,
        difficulty: memory.difficulty,
        scheduledDays: Math.max(ivl, 0),
        elapsedDays: prevDay == null ? 0 : Math.max(0, day - prevDay),
        durationMs: clamp(time, 0, MAX_DURATION_MS),
      })
      fresh = false
      prevDay = day
      if (batch.length >= REVLOG_CHUNK) await flush()
    }
    await flush()
  } finally {
    stmt.free()
  }
}

// ── Media ─────────────────────────────────────────────────────────────────────

const MEDIA_BATCH_FILES = 200
const MEDIA_BATCH_BYTES = 16 * 1024 * 1024

/** Extract a set of entries; if the batch fails, retry one by one so one bad file does not sink the rest. */
function extract(zip: Uint8Array, names: Set<string>): Unzipped {
  try {
    return unzipSync(zip, { filter: (f) => names.has(f.name) })
  } catch {
    const out: Unzipped = {}
    for (const name of names) {
      try {
        Object.assign(out, unzipSync(zip, { filter: (f) => f.name === name }))
      } catch {
        /* reported as broken by the caller */
      }
    }
    return out
  }
}

async function importMedia(pkg: AnkiPackage, result: ApkgImportResult, onPart: (part: number) => void): Promise<void> {
  const zip = pkg.zip
  if (!zip || !pkg.media.length) return
  const sizes = new Map<string, number>()
  unzipSync(zip, {
    filter: (f) => {
      sizes.set(f.name, f.size)
      return false
    },
  })
  const refs = pkg.media.filter((m) => sizes.has(m.zipName))
  const missing = pkg.media.length - refs.length
  let broken = 0
  for (let i = 0; i < refs.length; ) {
    const batch: MediaRef[] = []
    let bytes = 0
    while (i < refs.length && batch.length < MEDIA_BATCH_FILES && (batch.length === 0 || bytes < MEDIA_BATCH_BYTES)) {
      const ref = refs[i++]
      batch.push(ref)
      bytes += sizes.get(ref.zipName) ?? 0
    }
    const files = extract(zip, new Set(batch.map((m) => m.zipName)))
    const items: [string, Uint8Array][] = []
    for (const ref of batch) {
      const raw = files[ref.zipName]
      try {
        if (!raw) throw new Error('missing')
        items.push([ref.name, unzstd(raw)])
      } catch {
        broken++
      }
    }
    try {
      await db.transaction('rw', db.media, async () => {
        for (const [name, data] of items) await putMediaFile(name, data)
      })
    } catch (e) {
      // Notes are already saved: report the problem instead of failing the whole import.
      const saved = `сохранено ${result.media} из ${pkg.media.length}`
      result.warnings.push(isQuotaError(e) ? `Не хватило места для медиафайлов: ${saved}` : `Не удалось сохранить медиафайлы: ${saved}`)
      return
    }
    result.media += items.length
    onPart(i / refs.length)
    await yieldToUi()
  }
  if (missing) result.warnings.push(`Не найдены в архиве медиафайлы: ${missing}`)
  if (broken) result.warnings.push(`Не импортированы повреждённые медиафайлы: ${broken}`)
}

// ── Import ────────────────────────────────────────────────────────────────────

async function runImport(pkg: AnkiPackage, col: AnkiCollection, keep: boolean, report: Report): Promise<ApkgImportResult> {
  const sql = pkg.sql
  const result: ApkgImportResult = {
    notesAdded: 0,
    notesUpdated: 0,
    notesSkipped: 0,
    cardsAdded: 0,
    decks: [],
    noteTypesAdded: 0,
    media: 0,
    reviewsImported: 0,
    warnings: [...pkg.warnings],
  }
  report(STAGE_PREPARE, 0.08)
  const settings = await getSettings()
  const now = Date.now()
  const cutoff = settings.dayCutoff
  const withRevlog = keep && col.tables.has('revlog')

  // Progress budget after reading: proportional to the work left.
  const noteCount = scalar(sql, 'SELECT count(*) FROM notes')
  const revCount = withRevlog ? scalar(sql, 'SELECT count(*) FROM revlog') : 0
  const weights = [Math.max(1, noteCount), revCount * 0.05, pkg.media.length * 2]
  const sum = weights[0] + weights[1] + weights[2]
  const notesEnd = 0.12 + (0.88 * weights[0]) / sum
  const revEnd = notesEnd + (0.88 * weights[1]) / sum
  const span = (stage: string, from: number, to: number) => (part: number) => report(stage, from + (to - from) * clamp(part, 0, 1))

  const cardsByNote = readCards(sql)
  const cardDecks = new Map<string, [number, number]>()
  for (const cards of cardsByNote.values()) for (const c of cards) cardDecks.set(`${c.did}:${c.odid}`, [c.did, c.odid])
  const plan = planDecks(col.decks, cardDecks.values())
  const deckIds = new Map<string, number>()
  for (const name of plan.names) {
    const description = plan.descriptions.get(name)
    deckIds.set(name, await createDeck(name, description ? { description } : {}))
  }
  result.decks = plan.names

  const mids: number[] = []
  each(sql, 'SELECT DISTINCT mid FROM notes', (r) => mids.push(int(r[0])))
  const types = await importNoteTypes(col, mids, now, result)
  report(STAGE_PREPARE, 0.12)

  const w = parseWeights(settings.weights) ?? default_w
  const ctx: CardContext = {
    keep,
    now,
    cutoff,
    // crt is the rollover hour of the creation day; noon of that day is safe across time zones.
    crtDay: dayIndex(col.crt * 1000 + 12 * 3_600_000, cutoff),
    learnSteps: (parseSteps(settings.learningSteps) ?? ['1m', '10m']).length,
    relearnSteps: (parseSteps(settings.relearningSteps) ?? ['10m']).length,
    w,
    newDue: newCardOrder(cardsByNote, keep, now),
    lastReview: withRevlog ? lastReviews(sql, col.tables) : new Map(),
    deckOf: (c) => deckIds.get(plan.home(c.did, c.odid))!,
  }
  const added = new Map<number, AddedCard>()
  await importNotes(sql, noteCount, types, cardsByNote, ctx, added, result, span(STAGE_NOTES, 0.12, notesEnd))
  if (withRevlog && added.size) await importRevlog(sql, revCount, ctx, added, result, span(STAGE_REVLOG, notesEnd, revEnd))
  await importMedia(pkg, result, span(STAGE_MEDIA, revEnd, 1))
  if (noteCount === 0) result.warnings.push('В файле нет записей')
  report(STAGE_DONE, 1)
  return result
}
