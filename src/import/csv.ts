import { db } from '../db/db'
import { newCard, newGuid, noteSearchText } from '../db/repo'
import type { Card, Note } from '../db/types'
import { cardOrdinals } from '../render/template'
import { escapeHtml, isFieldEmpty, plainText } from '../render/html'
import { sanitizeFieldHtml } from '../render/sanitize'

export type Delimiter = '\t' | ',' | ';' | '|'

export interface ParsedText {
  rows: string[][]
  delimiter: Delimiter
  /** Anki "#html:true" header, or HTML found in the cells. */
  html: boolean
  /** Column index of tags from an Anki "#tags column:N" header, else -1. */
  tagsColumn: number
  /** Column names from an Anki "#columns:" header. */
  columns: string[] | null
}

/** Parse delimited text with quoted cells ("a ""b""", multi-line cells). */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

function detectDelimiter(sample: string): Delimiter {
  const lines = sample.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).slice(0, 10)
  let best: Delimiter = '\t'
  let bestScore = -1
  for (const d of ['\t', ';', ',', '|'] as Delimiter[]) {
    const counts = lines.map((l) => l.split(d).length - 1)
    const min = Math.min(...counts)
    const score = min > 0 ? min * 10 + (counts.every((c) => c === counts[0]) ? 5 : 0) : 0
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

const SEPARATORS: Record<string, Delimiter> = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', '\t': '\t', ',': ',', ';': ';', '|': '|' }

export function parseTextFile(raw: string, forced?: Delimiter): ParsedText {
  const text = raw.replace(/^﻿/, '')
  const lines = text.split(/\r?\n/)
  let delimiter: Delimiter | undefined = forced
  let html = false
  let tagsColumn = -1
  let columns: string[] | null = null
  let start = 0
  // Anki text exports start with "#key:value" header lines.
  while (start < lines.length && lines[start].startsWith('#')) {
    const m = /^#([\w ]+):(.*)$/.exec(lines[start])
    if (m) {
      const key = m[1].trim().toLowerCase()
      const val = m[2].trim()
      if (key === 'separator' && !forced) delimiter = SEPARATORS[val.toLowerCase()] ?? delimiter
      if (key === 'html') html = val === 'true'
      if (key === 'tags column') tagsColumn = Number(val) - 1
      if (key === 'columns') columns = val.split(delimiter ?? '\t')
    }
    start++
  }
  const body = lines.slice(start).join('\n')
  delimiter ??= detectDelimiter(body)
  const rows = parseDelimited(body, delimiter)
  if (!html) html = rows.slice(0, 50).some((r) => r.some((c) => /<(b|i|u|br|div|img|span|p)\b/i.test(c)))
  return { rows, delimiter, html, tagsColumn, columns }
}

export interface CsvMapping {
  typeId: number
  deckId: number
  /** For each note type field, the column index or -1. */
  fieldColumns: number[]
  tagsColumn: number
  skipFirstRow: boolean
  html: boolean
  /** Skip rows whose first field matches an existing note of the same type. */
  skipDuplicates: boolean
  extraTags: string[]
}

export interface CsvResult {
  added: number
  cards: number
  duplicates: number
  empty: number
}

function toHtml(cell: string, html: boolean): string {
  if (html) return sanitizeFieldHtml(cell)
  return escapeHtml(cell).replace(/\r?\n/g, '<br>')
}

export async function importRows(rows: string[][], m: CsvMapping, onProgress?: (f: number) => void): Promise<CsvResult> {
  const type = await db.noteTypes.get(m.typeId)
  if (!type) throw new Error('Тип записи не найден')
  const names = type.fields.map((f) => f.name)
  const existing = new Set<string>()
  if (m.skipDuplicates) {
    await db.notes
      .where('typeId')
      .equals(m.typeId)
      .each((n) => {
        existing.add(plainText(n.fields[0] ?? '').toLowerCase())
      })
  }
  const data = m.skipFirstRow ? rows.slice(1) : rows
  const res: CsvResult = { added: 0, cards: 0, duplicates: 0, empty: 0 }
  const now = Date.now()
  const CHUNK = 500
  for (let i = 0; i < data.length; i += CHUNK) {
    const notes: Omit<Note, 'id'>[] = []
    const ordsList: number[][] = []
    for (const row of data.slice(i, i + CHUNK)) {
      const fields = m.fieldColumns.map((c) => (c >= 0 && c < row.length ? toHtml(row[c].trim(), m.html) : ''))
      const ords = cardOrdinals(type.kind, type.templates, names, fields)
      // Like Anki, a note needs its first field.
      if (!ords.length || isFieldEmpty(fields[0])) {
        res.empty++
        continue
      }
      const key = plainText(fields[0]).toLowerCase()
      if (m.skipDuplicates && existing.has(key)) {
        res.duplicates++
        continue
      }
      existing.add(key)
      const tags = [
        ...new Set([
          ...m.extraTags,
          ...(m.tagsColumn >= 0 && row[m.tagsColumn] ? row[m.tagsColumn].split(/\s+/).filter(Boolean) : []),
        ]),
      ]
      notes.push({ typeId: m.typeId, guid: newGuid(), fields, tags, searchText: noteSearchText(fields, tags), createdAt: now + i, updatedAt: now })
      ordsList.push(ords)
    }
    await db.transaction('rw', db.notes, db.cards, async () => {
      const ids = (await db.notes.bulkAdd(notes as Note[], { allKeys: true })) as number[]
      const cards: Omit<Card, 'id'>[] = []
      ids.forEach((id, k) => {
        for (const ord of ordsList[k]) cards.push(newCard(id, m.deckId, ord, now, now + (i + k) * 10 + ord))
      })
      await db.cards.bulkAdd(cards as Card[])
      res.added += ids.length
      res.cards += cards.length
    })
    onProgress?.(Math.min(1, (i + CHUNK) / data.length))
    await new Promise((r) => setTimeout(r, 0))
  }
  return res
}
