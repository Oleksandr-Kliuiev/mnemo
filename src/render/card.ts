import type { Card, Note, NoteType } from '../db/types'
import { decodeEntities, escapeHtml } from './html'
import { sanitizeCardHtml } from './sanitize'
import { TYPE_MARKER, renderTemplate, type RenderContext } from './template'
import { compareTypeAnswer } from './typeans'

export interface RenderedCard {
  question: string
  answer: string
  css: string
  typeExpected: string | null
  /** Media file names of [sound:…] tags, in order, per side. */
  questionSounds: string[]
  answerSounds: string[]
}

const TYPE_INPUT =
  '<input id="typeans" class="typeans-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" placeholder="Введите ответ">'

/** Replace [sound:x] with play buttons; returns the html and the files in order. */
function processSounds(html: string): { html: string; sounds: string[] } {
  const sounds: string[] = []
  const out = html
    .replace(/\[sound:([^\]]+)\]/g, (_m, raw: string) => {
      const name = decodeEntities(raw.trim())
      sounds.push(name)
      return `<button type="button" class="mn-audio" data-sound="${escapeHtml(name)}" aria-label="Воспроизвести звук"></button>`
    })
    // Newer Anki TTS syntax: [anki:tts lang=en_US]text[/anki:tts]
    .replace(/\[anki:tts([^\]]*)\]([\s\S]*?)\[\/anki:tts\]/g, (_m, opts: string, text: string) => {
      const lang = /lang=([\w-]+)/.exec(opts)?.[1]?.replace('_', '-') ?? ''
      return `<button type="button" class="mn-tts" data-lang="${escapeHtml(lang)}" data-text="${escapeHtml(decodeEntities(text.replace(/<[^>]*>/g, '')))}" aria-label="Озвучить"></button>`
    })
  return { html: out, sounds }
}

export function buildContext(nt: NoteType, note: Note, card: Pick<Card, 'ord' | 'flag'>, deckName: string): RenderContext {
  const fields: Record<string, string> = {}
  nt.fields.forEach((f, i) => (fields[f.name] = note.fields[i] ?? ''))
  const tmpl = nt.kind === 'cloze' ? nt.templates[0] : (nt.templates[card.ord] ?? nt.templates[0])
  return {
    fields,
    kind: nt.kind,
    ord: card.ord,
    tags: note.tags,
    deckName,
    noteTypeName: nt.name,
    templateName: tmpl?.name ?? '',
    flag: card.flag,
  }
}

export function renderCard(
  nt: NoteType,
  note: Note,
  card: Pick<Card, 'ord' | 'flag'>,
  deckName: string,
  typed: string | null = null,
): RenderedCard {
  const tmpl = nt.kind === 'cloze' ? nt.templates[0] : (nt.templates[card.ord] ?? nt.templates[0])
  if (!tmpl) {
    return { question: '', answer: '', css: nt.css, typeExpected: null, questionSounds: [], answerSounds: [] }
  }
  const ctx = buildContext(nt, note, card, deckName)
  const q = renderTemplate(tmpl.qfmt, ctx, 'q')
  const frontForAnswer = q.html.replaceAll(TYPE_MARKER, '')
  const a = renderTemplate(tmpl.afmt, ctx, 'a', frontForAnswer)
  const expected = q.typeExpected ?? a.typeExpected
  const qHtml = q.html.replaceAll(TYPE_MARKER, TYPE_INPUT)
  const aHtml = a.html.replaceAll(TYPE_MARKER, expected != null ? compareTypeAnswer(typed ?? '', expected) : '')
  const qs = processSounds(sanitizeCardHtml(qHtml))
  const as = processSounds(sanitizeCardHtml(aHtml))
  // Sounds already heard on the question side are not replayed with the answer.
  const qCount = new Map<string, number>()
  for (const s of qs.sounds) qCount.set(s, (qCount.get(s) ?? 0) + 1)
  const answerOnly = as.sounds.filter((s) => {
    const c = qCount.get(s) ?? 0
    if (c > 0) {
      qCount.set(s, c - 1)
      return false
    }
    return true
  })
  return {
    question: qs.html,
    answer: as.html,
    css: nt.css,
    typeExpected: expected,
    questionSounds: qs.sounds,
    answerSounds: answerOnly,
  }
}
