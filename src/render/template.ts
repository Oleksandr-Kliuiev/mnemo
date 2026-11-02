/**
 * Anki-compatible card templates: {{Field}}, {{#Field}}…{{/Field}}, {{^Field}}…{{/Field}},
 * {{FrontSide}}, filters (cloze, cloze-only, type, text, hint, furigana, kana, kanji, nc, tts)
 * and special fields (Tags, Type, Deck, Subdeck, Card, CardFlag).
 */
import type { NoteKind } from '../db/types'
import { clozeOnly, clozeOnlyText, clozeNumbers, renderCloze } from './cloze'
import { escapeHtml, isFieldEmpty, plainText } from './html'

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; name: string; filters: string[] }
  | { t: 'section'; name: string; inverted: boolean; kids: Node[] }

const astCache = new Map<string, Node[]>()

export function parseTemplate(src: string): Node[] {
  const cached = astCache.get(src)
  if (cached) return cached
  const root: Node[] = []
  const stack: { name: string; kids: Node[] }[] = [{ name: '', kids: root }]
  const re = /\{\{([\s\S]*?)\}\}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1]
    if (m.index > last) top.kids.push({ t: 'text', v: src.slice(last, m.index) })
    last = re.lastIndex
    const inner = m[1].trim()
    if (!inner || inner[0] === '!') continue
    if (inner[0] === '#' || inner[0] === '^') {
      const sec: Node = { t: 'section', name: inner.slice(1).trim(), inverted: inner[0] === '^', kids: [] }
      top.kids.push(sec)
      stack.push({ name: sec.name, kids: sec.kids })
    } else if (inner[0] === '/') {
      const name = inner.slice(1).trim()
      // Close the matching section; tolerate sloppy nesting the way Anki users write it.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i
          break
        }
      }
    } else {
      const parts = inner.split(':')
      const name = parts.pop()!.trim()
      top.kids.push({ t: 'var', name, filters: parts.map((p) => p.trim()) })
    }
  }
  if (last < src.length) stack[stack.length - 1].kids.push({ t: 'text', v: src.slice(last) })
  if (astCache.size > 500) astCache.clear()
  astCache.set(src, root)
  return root
}

export interface RenderContext {
  fields: Record<string, string>
  kind: NoteKind
  /** Card ordinal: template index, or cloze number − 1. */
  ord: number
  tags: string[]
  deckName: string
  noteTypeName: string
  templateName: string
  flag: number
}

export interface RenderOutput {
  html: string
  /** Expected answer when the template contains {{type:…}}. */
  typeExpected: string | null
}

export const TYPE_MARKER = '\u0001mnemo-type\u0001'

function specialField(name: string, ctx: RenderContext, frontSide: string | undefined): string | undefined {
  switch (name) {
    case 'FrontSide':
      return frontSide ?? ''
    case 'Tags':
      return ctx.tags.join(' ')
    case 'Type':
      return ctx.noteTypeName
    case 'Deck':
      return ctx.deckName
    case 'Subdeck':
      return ctx.deckName.split('::').pop() ?? ''
    case 'Card':
      return ctx.templateName
    case 'CardFlag':
      return ctx.flag ? `flag${ctx.flag}` : ''
    default:
      return undefined
  }
}

function sectionIsTrue(name: string, ctx: RenderContext): boolean {
  const cm = /^c(\d+)$/.exec(name)
  if (ctx.kind === 'cloze' && cm && !(name in ctx.fields)) return Number(cm[1]) === ctx.ord + 1
  const special = specialField(name, ctx, undefined)
  if (special !== undefined) return special.trim() !== ''
  return !isFieldEmpty(ctx.fields[name])
}

// Furigana: "漢字[かんじ]" with an optional leading space separating words.
const FURIGANA_RE = / ?([^ >[\]]+?)\[(.+?)\]/g

function furigana(s: string): string {
  return s.replace(FURIGANA_RE, (_m, base: string, reading: string) =>
    reading.startsWith('sound:') ? _m : `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`,
  )
}
function kana(s: string): string {
  return s.replace(FURIGANA_RE, (_m, _b: string, reading: string) => (reading.startsWith('sound:') ? _m : reading))
}
function kanji(s: string): string {
  return s.replace(FURIGANA_RE, (_m, base: string, reading: string) => (reading.startsWith('sound:') ? _m : base))
}

/** Anki tts filter options, e.g. "tts en_US voices=Apple_Samantha speed=1.1". */
function ttsButton(filter: string, value: string): string {
  const parts = filter.split(/\s+/)
  const lang = (parts[1] ?? '').replace('_', '-')
  const speed = parts.find((p) => p.startsWith('speed='))?.slice(6) ?? '1'
  const text = plainText(value)
  if (!text) return ''
  return `<button type="button" class="mn-tts" data-lang="${escapeHtml(lang)}" data-rate="${escapeHtml(speed)}" data-text="${escapeHtml(text)}" aria-label="Озвучить"></button>`
}

function applyFilter(filter: string, value: string, fieldName: string, ctx: RenderContext, side: 'q' | 'a'): string {
  const f = filter.toLowerCase()
  if (f === 'cloze') return ctx.kind === 'cloze' ? renderCloze(value, ctx.ord + 1, side) : value
  if (f === 'cloze-only') return clozeOnly(value, ctx.ord + 1)
  if (f === 'text') return escapeHtml(plainText(value))
  if (f === 'hint') {
    if (isFieldEmpty(value)) return ''
    return `<details class="hint"><summary>${escapeHtml(fieldName)}</summary>${value}</details>`
  }
  if (f === 'furigana') return furigana(value)
  if (f === 'kana') return kana(value)
  if (f === 'kanji') return kanji(value)
  if (f === 'nc') return value.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
  if (f.startsWith('tts')) return ttsButton(filter, value)
  return value
}

function evaluate(
  nodes: Node[],
  ctx: RenderContext,
  side: 'q' | 'a',
  frontSide: string | undefined,
  state: { typeExpected: string | null },
): string {
  let out = ''
  for (const node of nodes) {
    if (node.t === 'text') {
      out += node.v
    } else if (node.t === 'section') {
      const on = sectionIsTrue(node.name, ctx)
      if (on !== node.inverted) out += evaluate(node.kids, ctx, side, frontSide, state)
    } else {
      const special = specialField(node.name, ctx, frontSide)
      let value: string
      if (special !== undefined) {
        value = special
      } else if (node.name in ctx.fields) {
        value = ctx.fields[node.name]
      } else {
        out += `<span class="mn-error">Нет поля «${escapeHtml(node.name)}»</span>`
        continue
      }
      const filters = node.filters.map((x) => x.toLowerCase())
      if (filters.includes('type')) {
        state.typeExpected =
          filters.includes('cloze') && ctx.kind === 'cloze' ? clozeOnlyText(value, ctx.ord + 1) : plainText(value)
        out += TYPE_MARKER
        continue
      }
      for (let i = node.filters.length - 1; i >= 0; i--) {
        value = applyFilter(node.filters[i], value, node.name, ctx, side)
      }
      out += value
    }
  }
  return out
}

export function renderTemplate(src: string, ctx: RenderContext, side: 'q' | 'a', frontSide?: string): RenderOutput {
  const state = { typeExpected: null as string | null }
  const html = evaluate(parseTemplate(src), ctx, side, frontSide, state)
  return { html, typeExpected: state.typeExpected }
}

/** Field names that a template feeds through the cloze filter. */
export function clozeFieldNames(qfmt: string): string[] {
  const out: string[] = []
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.t === 'section') walk(n.kids)
      else if (n.t === 'var' && n.filters.some((f) => f.toLowerCase() === 'cloze')) out.push(n.name)
    }
  }
  walk(parseTemplate(qfmt))
  return out
}

/**
 * Which card ordinals a note should have.
 * Standard: a template yields a card when its front shows any non-empty field.
 * Cloze: one card per cloze number in the cloze fields.
 */
export function cardOrdinals(
  kind: NoteKind,
  templates: { qfmt: string; name: string }[],
  fieldNames: string[],
  values: string[],
): number[] {
  const fields: Record<string, string> = {}
  const empty: Record<string, string> = {}
  fieldNames.forEach((n, i) => {
    fields[n] = values[i] ?? ''
    empty[n] = ''
  })
  if (kind === 'cloze') {
    const names = templates[0] ? clozeFieldNames(templates[0].qfmt) : []
    const src = (names.length ? names : fieldNames).map((n) => fields[n] ?? '').join(' ')
    return clozeNumbers(src).map((n) => n - 1)
  }
  const out: number[] = []
  templates.forEach((t, i) => {
    const base = { kind, ord: i, tags: [], deckName: '', noteTypeName: '', templateName: t.name, flag: 0 }
    const full = renderTemplate(t.qfmt, { ...base, fields }, 'q').html
    const blank = renderTemplate(t.qfmt, { ...base, fields: empty }, 'q').html
    if (full !== blank && !isFieldEmpty(full.replaceAll(TYPE_MARKER, ''))) out.push(i)
  })
  return out
}

/** Rename field references in a template in one pass, so swaps and chains work. */
export function renameFieldRefs(src: string, renames: Map<string, string>): string {
  if (renames.size === 0) return src
  return src.replace(/\{\{([#^/]?)((?:[^}:]*:)*)\s*([^}:]*?)\s*\}\}/g, (m, mark: string, filters: string, field: string) =>
    renames.has(field) ? `{{${mark}${filters}${renames.get(field)}}}` : m,
  )
}
