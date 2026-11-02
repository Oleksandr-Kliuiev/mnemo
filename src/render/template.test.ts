import { describe, expect, it } from 'vitest'
import { renderTemplate, cardOrdinals, type RenderContext } from './template'
import { clozeNumbers, renderCloze, clozeOnly } from './cloze'
import { compareTypeAnswer } from './typeans'
import { renderCard } from './card'
import { isFieldEmpty, plainText } from './html'
import { BUILTIN_NOTE_TYPES } from '../db/builtins'
import type { Note, NoteType } from '../db/types'

const ctx = (fields: Record<string, string>, extra: Partial<RenderContext> = {}): RenderContext => ({
  fields,
  kind: 'standard',
  ord: 0,
  tags: ['a', 'b'],
  deckName: 'Языки::Английский',
  noteTypeName: 'Базовая',
  templateName: 'Карточка 1',
  flag: 0,
  ...extra,
})

describe('template', () => {
  it('substitutes fields and special fields', () => {
    const r = renderTemplate('{{Front}} | {{Deck}} | {{Subdeck}} | {{Tags}}', ctx({ Front: 'cat' }), 'q')
    expect(r.html).toBe('cat | Языки::Английский | Английский | a b')
  })
  it('handles sections and inverted sections', () => {
    const t = '{{#Extra}}[{{Extra}}]{{/Extra}}{{^Extra}}none{{/Extra}}'
    expect(renderTemplate(t, ctx({ Extra: 'x' }), 'q').html).toBe('[x]')
    expect(renderTemplate(t, ctx({ Extra: ' <br> ' }), 'q').html).toBe('none')
  })
  it('renders FrontSide on the answer', () => {
    const r = renderTemplate('{{FrontSide}}<hr id=answer>{{Back}}', ctx({ Back: 'B' }), 'a', 'F')
    expect(r.html).toBe('F<hr id=answer>B')
  })
  it('applies filters right to left', () => {
    expect(renderTemplate('{{text:Front}}', ctx({ Front: '<b>bold</b> &amp; x' }), 'q').html).toBe('bold &amp; x')
    expect(renderTemplate('{{kanji:F}}/{{kana:F}}', ctx({ F: '日本[にほん]' }), 'q').html).toBe('日本/にほん')
    expect(renderTemplate('{{furigana:F}}', ctx({ F: '日本[にほん]' }), 'q').html).toContain('<ruby><rb>日本</rb><rt>にほん</rt></ruby>')
  })
  it('marks unknown fields', () => {
    expect(renderTemplate('{{Nope}}', ctx({}), 'q').html).toContain('Нет поля')
  })
  it('records the expected typed answer', () => {
    const r = renderTemplate('{{Front}} {{type:Back}}', ctx({ Front: 'q', Back: '<i>answer</i>' }), 'q')
    expect(r.typeExpected).toBe('answer')
  })
})

describe('cloze', () => {
  it('finds cloze numbers, including nested', () => {
    expect(clozeNumbers('{{c1::a}} {{c3::b {{c2::c}}}}')).toEqual([1, 2, 3])
  })
  it('renders question and answer sides', () => {
    const t = 'Столица {{c1::Франции}} — {{c2::Париж::город}}'
    expect(renderCloze(t, 1, 'q')).toContain('[...]')
    expect(renderCloze(t, 1, 'q')).toContain('Париж')
    expect(renderCloze(t, 2, 'q')).toContain('[город]')
    expect(renderCloze(t, 2, 'a')).toContain('<span class="cloze" data-ordinal="2">Париж</span>')
    expect(clozeOnly(t, 2)).toBe('Париж')
  })
  it('keeps unclosed deletions as text', () => {
    expect(plainText(renderCloze('{{c1::open', 1, 'q'))).toBe('{{c1::open')
  })
})

describe('card generation', () => {
  const byKey = (k: string) => BUILTIN_NOTE_TYPES.find((t) => t.builtin === k)!
  it('creates both directions for basic-reverse', () => {
    const t = byKey('basic-reverse')
    expect(cardOrdinals(t.kind, t.templates, t.fields.map((f) => f.name), ['a', 'b'])).toEqual([0, 1])
    expect(cardOrdinals(t.kind, t.templates, t.fields.map((f) => f.name), ['a', ''])).toEqual([0])
  })
  it('optional reverse only when the third field is filled', () => {
    const t = byKey('basic-optional-reverse')
    const names = t.fields.map((f) => f.name)
    expect(cardOrdinals(t.kind, t.templates, names, ['a', 'b', ''])).toEqual([0])
    expect(cardOrdinals(t.kind, t.templates, names, ['a', 'b', 'y'])).toEqual([0, 1])
  })
  it('cloze notes get one card per number', () => {
    const t = byKey('cloze')
    expect(cardOrdinals(t.kind, t.templates, t.fields.map((f) => f.name), ['{{c1::a}} {{c2::b}} {{c2::c}}', ''])).toEqual([0, 1])
    expect(cardOrdinals(t.kind, t.templates, t.fields.map((f) => f.name), ['no clozes', ''])).toEqual([])
  })
})

describe('renderCard', () => {
  const nt = { ...BUILTIN_NOTE_TYPES.find((t) => t.builtin === 'basic-type')!, id: 1, createdAt: 0, updatedAt: 0 } as NoteType
  const note = { id: 1, typeId: 1, guid: 'g', fields: ['Capital of France?', 'Paris [sound:paris.mp3]'], tags: [], searchText: '', createdAt: 0, updatedAt: 0 } as Note
  it('renders a type-in input and compares on the answer', () => {
    const r = renderCard(nt, note, { ord: 0, flag: 0 }, 'D', 'Pariss')
    expect(r.question).toContain('id="typeans"')
    expect(r.answer).toContain('typeBad')
    expect(r.answer).toContain('<hr id="answer">')
  })
  it('strips scripts and event handlers', () => {
    const evil = { ...note, fields: ['<img src=x onerror="alert(1)"><script>alert(2)</script>Q', 'A'] }
    const basic = { ...BUILTIN_NOTE_TYPES[0], id: 2, createdAt: 0, updatedAt: 0 } as NoteType
    const r = renderCard(basic, evil, { ord: 0, flag: 0 }, 'D')
    expect(r.question).not.toContain('onerror')
    expect(r.question).not.toContain('<script')
  })
  it('turns sound tags into buttons', () => {
    const basic = { ...BUILTIN_NOTE_TYPES[0], id: 2, createdAt: 0, updatedAt: 0 } as NoteType
    const r = renderCard(basic, { ...note, fields: ['[sound:a.mp3]Q', 'A [sound:b.mp3]'] }, { ord: 0, flag: 0 }, 'D')
    expect(r.questionSounds).toEqual(['a.mp3'])
    expect(r.answerSounds).toEqual(['b.mp3'])
    expect(r.answer).toContain('data-sound="b.mp3"')
  })
})

describe('type answer diff', () => {
  it('marks exact matches green', () => {
    expect(compareTypeAnswer('Paris', 'Paris')).toContain('typeGood')
    expect(compareTypeAnswer('Paris', 'Paris')).not.toContain('typeBad')
  })
  it('shows missing and wrong characters', () => {
    const html = compareTypeAnswer('Pari', 'Paris')
    expect(html).toContain('typeMissed')
  })
})

describe('html helpers', () => {
  it('detects empty fields', () => {
    expect(isFieldEmpty('<div><br></div>&nbsp;')).toBe(true)
    expect(isFieldEmpty('<img src="a.png">')).toBe(false)
  })
})

describe('field sanitizing', () => {
  it('keeps Anki formatting but drops scripts', async () => {
    const { sanitizeFieldHtml } = await import('./sanitize')
    const html = sanitizeFieldHtml('<img src="a.png" width="120" height="80"><table><tr><td colspan="2"><small>x</small></td></tr></table><script>alert(1)</script><a href="javascript:alert(1)">l</a>')
    expect(html).toContain('width="120"')
    expect(html).toContain('colspan="2"')
    expect(html).toContain('<small>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
  })
})

describe('review fixes', () => {
  it('renames fields in one pass (swaps work)', async () => {
    const { renameFieldRefs } = await import('./template')
    const map = new Map([['Front', 'Back'], ['Back', 'Front']])
    expect(renameFieldRefs('{{Front}}<hr id=answer>{{type:Back}}{{#Front}}x{{/Front}}', map)).toBe('{{Back}}<hr id=answer>{{type:Front}}{{#Back}}x{{/Back}}')
  })
  it('sound tags inside attributes cannot inject markup', () => {
    const basic = { ...BUILTIN_NOTE_TYPES[0], id: 2, createdAt: 0, updatedAt: 0 } as NoteType
    const evil = { id: 1, typeId: 2, guid: 'g', fields: ['<span title="[sound:x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.mp3]">t</span>', 'A'], tags: [], searchText: '', createdAt: 0, updatedAt: 0 } as Note
    const r = renderCard(basic, evil, { ord: 0, flag: 0 }, 'D')
    const div = document.createElement('div')
    div.innerHTML = r.question
    // The payload may survive as inert attribute text, but never as an element or a handler.
    expect(div.querySelector('img')).toBeNull()
    const handlers = [...div.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name)).filter((n) => n.startsWith('on'))
    expect(handlers).toEqual([])
  })
})
