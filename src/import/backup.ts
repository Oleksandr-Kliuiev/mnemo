import { unzip, zip, strToU8, strFromU8, type Unzipped, type Zippable } from 'fflate'
import { db } from '../db/db'
import { mimeFromName } from '../db/media'
import type { Card, Deck, MediaFile, Note, NoteType, ReviewEntry, SettingRow } from '../db/types'

const MANIFEST = 'mnemo-backup.json'
const FORMAT = 1

interface BackupJson {
  app: 'mnemo'
  format: number
  exportedAt: number
  decks: Deck[]
  noteTypes: NoteType[]
  notes: Note[]
  cards: Card[]
  revlog: ReviewEntry[]
  settings: SettingRow[]
  media: { name: string; type: string }[]
}

export interface BackupInfo {
  exportedAt: number
  decks: number
  notes: number
  cards: number
  reviews: number
  media: number
}

function zipAsync(files: Zippable): Promise<Uint8Array> {
  return new Promise((res, rej) => zip(files, { level: 6 }, (err, data) => (err ? rej(err) : res(data))))
}

function unzipAsync(data: Uint8Array): Promise<Unzipped> {
  return new Promise((res, rej) => unzip(data, (err, out) => (err ? rej(err) : res(out))))
}

export async function exportBackup(onProgress?: (f: number) => void): Promise<Blob> {
  const [decks, noteTypes, notes, cards, revlog, settings] = await Promise.all([
    db.decks.toArray(),
    db.noteTypes.toArray(),
    db.notes.toArray(),
    db.cards.toArray(),
    db.revlog.toArray(),
    db.settings.toArray(),
  ])
  const files: Zippable = {}
  const media: { name: string; type: string }[] = []
  const names = (await db.media.toCollection().primaryKeys()) as string[]
  let done = 0
  for (const name of names) {
    const m = await db.media.get(name)
    if (m) {
      // Media is already compressed (jpg, mp3…): store without recompressing.
      files[`media/${name}`] = [new Uint8Array(await m.blob.arrayBuffer()), { level: 0 }]
      media.push({ name, type: m.type })
    }
    done++
    if (done % 50 === 0) onProgress?.(0.1 + 0.7 * (done / names.length))
  }
  const json: BackupJson = { app: 'mnemo', format: FORMAT, exportedAt: Date.now(), decks, noteTypes, notes, cards, revlog, settings, media }
  files[MANIFEST] = strToU8(JSON.stringify(json))
  onProgress?.(0.85)
  const out = await zipAsync(files)
  onProgress?.(1)
  return new Blob([out as BlobPart], { type: 'application/zip' })
}

async function readBackup(file: Blob): Promise<{ json: BackupJson; files: Unzipped }> {
  let files: Unzipped
  try {
    files = await unzipAsync(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw new Error('Файл повреждён или это не резервная копия Mnemo')
  }
  const raw = files[MANIFEST]
  if (!raw) throw new Error('В архиве нет данных Mnemo. Для колод Anki выберите файл .apkg')
  const json = JSON.parse(strFromU8(raw)) as BackupJson
  if (json.app !== 'mnemo' || typeof json.format !== 'number') throw new Error('Неизвестный формат резервной копии')
  if (json.format > FORMAT) throw new Error('Копия сделана более новой версией Mnemo — обновите приложение')
  return { json, files }
}

export async function isBackupZip(file: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    if (head[0] !== 0x50 || head[1] !== 0x4b) return false
    const { json } = await readBackup(file)
    return json.app === 'mnemo'
  } catch {
    return false
  }
}

export async function inspectBackup(file: Blob): Promise<BackupInfo> {
  const { json } = await readBackup(file)
  return {
    exportedAt: json.exportedAt,
    decks: json.decks.length,
    notes: json.notes.length,
    cards: json.cards.length,
    reviews: json.revlog.length,
    media: json.media.length,
  }
}

/** Replace everything with the backup's content. */
export async function restoreBackup(file: Blob, onProgress?: (f: number) => void): Promise<BackupInfo> {
  const { json, files } = await readBackup(file)
  onProgress?.(0.2)
  await db.transaction('rw', [db.decks, db.noteTypes, db.notes, db.cards, db.revlog, db.media, db.settings], async () => {
    await Promise.all([db.decks.clear(), db.noteTypes.clear(), db.notes.clear(), db.cards.clear(), db.revlog.clear(), db.media.clear(), db.settings.clear()])
    await db.decks.bulkAdd(json.decks)
    await db.noteTypes.bulkAdd(json.noteTypes)
    await db.notes.bulkAdd(json.notes)
    await db.cards.bulkAdd(json.cards)
    await db.revlog.bulkAdd(json.revlog)
    await db.settings.bulkAdd(json.settings)
    const media: MediaFile[] = []
    for (const m of json.media) {
      const data = files[`media/${m.name}`]
      if (!data) continue
      const type = m.type || mimeFromName(m.name)
      media.push({ name: m.name, blob: new Blob([data as BlobPart], { type }), type, size: data.byteLength, createdAt: Date.now() })
    }
    await db.media.bulkAdd(media)
  })
  onProgress?.(1)
  return {
    exportedAt: json.exportedAt,
    decks: json.decks.length,
    notes: json.notes.length,
    cards: json.cards.length,
    reviews: json.revlog.length,
    media: json.media.length,
  }
}

export function backupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `mnemo-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.zip`
}
