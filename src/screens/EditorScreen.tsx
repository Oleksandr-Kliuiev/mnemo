import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Bold, Eraser, Eye, ImagePlus, Italic, Pin, Trash2, Underline, X } from 'lucide-react'
import { Screen, Section } from '../ui/Screen'
import { Sheet } from '../ui/Sheet'
import { useDialogs } from '../ui/Dialogs'
import { useToast } from '../ui/Toast'
import { ButtonRow, DeckBadge, Loading, Segmented } from '../ui/controls'
import { CardView } from '../ui/CardView'
import { db, requestPersistentStorage } from '../db/db'
import { BUILTIN_HINTS } from '../db/builtins'
import {
  addNote,
  createDeck,
  deleteNotes,
  findDuplicates,
  forgetCards,
  leafName,
  moveCards,
  setSuspended,
  updateNote,
} from '../db/repo'
import { getMeta, setMeta, useSettings } from '../db/settings'
import { dehydrateMediaHtml, hydrateMediaHtml, prepareImage, saveMedia } from '../db/media'
import { CardState, type Card, type Deck, type Note, type NoteType } from '../db/types'
import { clozeNumbers } from '../render/cloze'
import { cardOrdinals } from '../render/template'
import { isFieldEmpty } from '../render/html'
import { sanitizeFieldHtml } from '../render/sanitize'
import { renderCard } from '../render/card'
import { dayIndex } from '../sched/day'
import { goBack } from '../lib/router'
import { useIsDark } from '../lib/theme'
import { CARDS, count, relativeDays } from '../lib/format'
import { formatDays } from '../sched/fsrs'
import { isApplePlatform, pickFile } from '../lib/platform'

// ── Editor state ──────────────────────────────────────────────────────────────

interface EditorData {
  types: NoteType[]
  decks: Deck[]
  note: Note | null
  cards: Card[]
}

function useEditorData(noteId?: number): EditorData | undefined {
  return useLiveQuery(async () => {
    const [types, decks] = await Promise.all([db.noteTypes.toArray(), db.decks.toArray()])
    decks.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    types.sort((a, b) => (a.builtin ? 0 : 1) - (b.builtin ? 0 : 1) || a.createdAt - b.createdAt)
    const note = noteId != null ? ((await db.notes.get(noteId)) ?? null) : null
    const cards = noteId != null ? await db.cards.where('noteId').equals(noteId).toArray() : []
    cards.sort((a, b) => a.ord - b.ord)
    return { types, decks, note, cards }
  }, [noteId])
}

function useEditor(noteId: number | undefined, initialDeckId: number | undefined) {
  const data = useEditorData(noteId)
  const isNew = noteId == null
  const [typeId, setTypeId] = useState<number | null>(null)
  const [deckId, setDeckId] = useState<number | null>(null)
  const [fields, setFields] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [sticky, setSticky] = useState<boolean[]>([])
  const [formKey, setFormKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dupes, setDupes] = useState(0)
  const [ready, setReady] = useState(false)

  // Initialise once the data arrives.
  useEffect(() => {
    if (!data || ready) return
    void (async () => {
      if (data.note) {
        setTypeId(data.note.typeId)
        setDeckId(data.cards[0]?.deckId ?? data.decks[0]?.id ?? null)
        setFields(await Promise.all(data.note.fields.map((f) => hydrateMediaHtml(f))))
        setTags(data.note.tags)
      } else {
        const lastType = await getMeta<number | null>('lastTypeId', null)
        const lastDeck = await getMeta<number | null>('lastDeckId', null)
        const t = data.types.find((x) => x.id === lastType) ?? data.types.find((x) => x.builtin === 'basic') ?? data.types[0]
        const d =
          data.decks.find((x) => x.id === initialDeckId) ?? data.decks.find((x) => x.id === lastDeck) ?? data.decks[0]
        setTypeId(t?.id ?? null)
        setDeckId(d?.id ?? null)
        setFields(t ? t.fields.map(() => '') : [])
        setSticky(t ? t.fields.map((f) => !!f.sticky) : [])
      }
      setReady(true)
    })()
  }, [data, ready, initialDeckId])

  const type = data?.types.find((t) => t.id === typeId)

  const changeType = (id: number) => {
    const next = data?.types.find((t) => t.id === id)
    if (!next) return
    setTypeId(id)
    // Keep values by position; extra values are dropped, missing ones are empty.
    setFields((old) => next.fields.map((_, i) => old[i] ?? ''))
    setSticky(next.fields.map((f) => !!f.sticky))
    setFormKey((k) => k + 1)
    setError(null)
  }

  const setField = (i: number, html: string) => {
    setFields((old) => {
      const copy = [...old]
      copy[i] = html
      return copy
    })
    setDirty(true)
    if (error) setError(null)
  }

  // Duplicate check on the first field.
  const first = fields[0] ?? ''
  useEffect(() => {
    if (!typeId || isFieldEmpty(first)) {
      setDupes(0)
      return
    }
    const t = setTimeout(() => {
      void findDuplicates(typeId, dehydrateMediaHtml(first), noteId).then(setDupes)
    }, 300)
    return () => clearTimeout(t)
  }, [first, typeId, noteId])

  const cleanFields = () => fields.map((f) => sanitizeFieldHtml(dehydrateMediaHtml(f)).replace(/^(<br>)+|(<br>)+$/g, ''))

  const validate = (vals: string[]): string | null => {
    if (!type) return 'Выберите тип записи'
    const ords = cardOrdinals(type.kind, type.templates, type.fields.map((f) => f.name), vals)
    if (type.kind === 'cloze' && clozeNumbers(vals.join(' ')).length === 0) {
      return 'Добавьте хотя бы один пропуск: выделите слово и нажмите кнопку «c1» на панели.'
    }
    if (ords.length === 0) return `Заполните поле «${type.fields[0]?.name ?? 'Вопрос'}»`
    return null
  }

  return {
    data,
    ready,
    isNew,
    type,
    typeId,
    deckId,
    setDeckId: (id: number) => {
      setDeckId(id)
      setDirty(true)
    },
    changeType,
    fields,
    setField,
    tags,
    setTags: (t: string[]) => {
      setTags(t)
      setDirty(true)
    },
    sticky,
    toggleSticky: (i: number) => setSticky((s) => s.map((v, j) => (j === i ? !v : v))),
    formKey,
    resetAfterAdd: () => {
      setFields((old) => old.map((v, i) => (sticky[i] ? v : '')))
      setFormKey((k) => k + 1)
      setDirty(false)
    },
    dirty,
    setDirty,
    error,
    setError,
    dupes,
    cleanFields,
    validate,
  }
}

type Editor = ReturnType<typeof useEditor>

function useSave(ed: Editor, noteId: number | undefined, onSaved: (kind: 'added' | 'saved') => void) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const save = useCallback(async () => {
    if (saving || !ed.type) return
    const vals = ed.cleanFields()
    const err = ed.validate(vals)
    if (err) {
      ed.setError(err)
      return
    }
    setSaving(true)
    try {
      let deckId = ed.deckId
      if (deckId == null) deckId = await createDeck('Моя колода')
      if (noteId == null) {
        const res = await addNote(ed.type.id, deckId, vals, ed.tags)
        void setMeta('lastTypeId', ed.type.id)
        void setMeta('lastDeckId', deckId)
        void requestPersistentStorage()
        toast.show(`Добавлено: ${count(res.cards, CARDS)}`)
        ed.resetAfterAdd()
        onSaved('added')
      } else {
        const added = await updateNote(noteId, vals, ed.tags, deckId)
        const cards = await db.cards.where('noteId').equals(noteId).toArray()
        const moved = cards.filter((c) => c.deckId !== deckId).map((c) => c.id)
        if (moved.length) await moveCards(moved, deckId)
        ed.setDirty(false)
        toast.show(added ? `Сохранено, новых карточек: ${added}` : 'Сохранено')
        onSaved('saved')
      }
    } catch (e) {
      ed.setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [ed, noteId, onSaved, saving, toast])
  return { save, saving }
}

// ── Rich text field ───────────────────────────────────────────────────────────

function RichField({
  id,
  value,
  onChange,
  onFocus,
  autoFocus,
  invalid,
  describedBy,
  placeholder,
  labelledBy,
  elRef,
}: {
  id: string
  value: string
  onChange: (html: string) => void
  onFocus: () => void
  autoFocus?: boolean
  invalid?: boolean
  describedBy?: string
  placeholder: string
  labelledBy: string
  elRef: (el: HTMLDivElement | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const initial = useRef(value)

  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = initial.current
      if (autoFocus) ref.current.focus({ preventScroll: true })
    }
    // Only on mount: the parent remounts the field (key) to reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const emit = () => {
    const el = ref.current
    if (!el) return
    // An emptied contenteditable keeps a stray <br>; treat it as empty so the placeholder returns.
    if (el.innerHTML === '<br>' || el.innerHTML === '<div><br></div>') el.innerHTML = ''
    onChange(el.innerHTML)
  }

  const onPaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      e.preventDefault()
      for (const f of files) await insertImageFile(f)
      emit()
      return
    }
    const html = e.clipboardData.getData('text/html')
    const text = e.clipboardData.getData('text/plain')
    e.preventDefault()
    if (html) {
      const tpl = document.createElement('template')
      tpl.innerHTML = sanitizeFieldHtml(html)
      tpl.content.querySelectorAll('[style],[class]').forEach((n) => {
        n.removeAttribute('style')
        n.removeAttribute('class')
      })
      document.execCommand('insertHTML', false, tpl.innerHTML)
    } else {
      document.execCommand('insertText', false, text)
    }
    emit()
  }

  return (
    <div
      id={id}
      ref={(el) => {
        ref.current = el
        elRef(el)
      }}
      className="rich"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-labelledby={labelledBy}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-placeholder={placeholder}
      spellCheck
      onInput={emit}
      onBlur={emit}
      onFocus={onFocus}
      onPaste={(e) => void onPaste(e)}
    />
  )
}

async function insertImageFile(file: File) {
  const { blob, ext } = await prepareImage(file)
  const name = await saveMedia(blob, ext)
  const url = URL.createObjectURL(blob)
  document.execCommand('insertHTML', false, `<img src="${url}" data-media="${name}" alt="">`)
}

// ── Tags ──────────────────────────────────────────────────────────────────────

function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const known = useLiveQuery(async () => (await db.notes.orderBy('tags').uniqueKeys()) as string[], [], [])
  const commit = (raw: string) => {
    const parts = raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (!parts.length) return
    onChange([...new Set([...tags, ...parts])])
    setDraft('')
  }
  return (
    <div className="tags">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
          <button type="button" aria-label={`Убрать метку ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
            <X size={14} aria-hidden />
          </button>
        </span>
      ))}
      <label className="sr-only" htmlFor="tag-input">
        Добавить метку
      </label>
      <input
        id="tag-input"
        list="known-tags"
        value={draft}
        placeholder={tags.length ? 'Ещё метка' : 'Метки через пробел'}
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint="done"
        onChange={(e) => {
          const v = e.target.value
          if (/[\s,]$/.test(v)) commit(v)
          else setDraft(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && !draft && tags.length) {
            onChange(tags.slice(0, -1))
          }
        }}
        onBlur={() => commit(draft)}
      />
      <datalist id="known-tags">
        {known.slice(0, 200).map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  )
}

// ── Pickers ───────────────────────────────────────────────────────────────────

function TypePicker({ open, onClose, types, value, onPick }: { open: boolean; onClose: () => void; types: NoteType[]; value: number | null; onPick: (id: number) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Тип записи">
      <div className="group">
        {types.map((t) => (
          <button
            key={t.id}
            type="button"
            className="row"
            aria-pressed={t.id === value}
            onClick={() => {
              onPick(t.id)
              onClose()
            }}
          >
            <span className={`check${t.id === value ? ' check--on' : ''}`} aria-hidden>
              ✓
            </span>
            <span className="row__body">
              <span className="row__title">{t.name}</span>
              <span className="row__sub">{(t.builtin && BUILTIN_HINTS[t.builtin]) || `${t.fields.length} поля · ${t.templates.length} шаблон(а)`}</span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  )
}

function DeckPicker({ open, onClose, decks, value, onPick }: { open: boolean; onClose: () => void; decks: Deck[]; value: number | null; onPick: (id: number) => void }) {
  const dialogs = useDialogs()
  return (
    <Sheet open={open} onClose={onClose} title="Колода">
      <div className="group">
        {decks.map((d) => {
          const depth = d.name.split('::').length - 1
          return (
            <button
              key={d.id}
              type="button"
              className="row"
              style={{ paddingLeft: `calc(var(--s-4) + ${depth * 20}px)` }}
              aria-pressed={d.id === value}
              onClick={() => {
                onPick(d.id)
                onClose()
              }}
            >
              <span className={`check${d.id === value ? ' check--on' : ''}`} aria-hidden>
                ✓
              </span>
              <DeckBadge color={d.color} emoji={d.emoji} name={leafName(d.name)} size="small" />
              <span className="row__body">
                <span className="row__title">{leafName(d.name)}</span>
              </span>
            </button>
          )
        })}
        <ButtonRow
          tone="accent"
          title="Новая колода…"
          onClick={async () => {
            const name = await dialogs.prompt({ title: 'Новая колода', label: 'Название', ok: 'Создать', placeholder: 'Например, «Английский»' })
            if (!name) return
            const id = await createDeck(name)
            onPick(id)
            onClose()
          }}
        />
      </div>
    </Sheet>
  )
}

// ── Preview ───────────────────────────────────────────────────────────────────

function PreviewSheet({ open, onClose, ed }: { open: boolean; onClose: () => void; ed: Editor }) {
  const dark = useIsDark()
  const settings = useSettings()
  const [ord, setOrd] = useState<number | null>(null)
  const [side, setSide] = useState<'q' | 'a'>('q')
  const type = ed.type
  const vals = useMemo(() => (open ? ed.fields.map((f) => dehydrateMediaHtml(f)) : []), [open, ed.fields])
  const ords = useMemo(() => (type ? cardOrdinals(type.kind, type.templates, type.fields.map((f) => f.name), vals) : []), [type, vals])
  const current = ord != null && ords.includes(ord) ? ord : ords[0]
  const deck = ed.data?.decks.find((d) => d.id === ed.deckId)
  if (!type) return null
  const note: Note = { id: 0, typeId: type.id, guid: '', fields: vals, tags: ed.tags, searchText: '', createdAt: 0, updatedAt: 0 }
  const r = current != null ? renderCard(type, note, { ord: current, flag: 0 }, deck?.name ?? '') : null
  const label = (o: number) => (type.kind === 'cloze' ? `Пропуск ${o + 1}` : (type.templates[o]?.name ?? `Карточка ${o + 1}`))
  return (
    <Sheet open={open} onClose={onClose} title="Просмотр" full>
      {r ? (
        <div className="stack">
          {ords.length > 1 && (
            <Segmented label="Карточка" value={current!} options={ords.map((o) => ({ value: o, label: label(o) }))} onChange={setOrd} />
          )}
          <Segmented
            label="Сторона"
            value={side}
            options={[
              { value: 'q', label: 'Вопрос' },
              { value: 'a', label: 'Ответ' },
            ]}
            onChange={setSide}
          />
          <div className="card-surface">
            <CardView html={side === 'q' ? r.question : r.answer} css={r.css} dark={dark} zoom={settings.cardFontScale} label={side === 'q' ? 'Вопрос' : 'Ответ'} />
          </div>
        </div>
      ) : (
        <p className="muted">Заполните поля — здесь появится карточка.</p>
      )}
    </Sheet>
  )
}

// ── Card list (edit mode) ─────────────────────────────────────────────────────

function CardsInfo({ type, cards }: { type: NoteType; cards: Card[] }) {
  const settings = useSettings()
  const dialogs = useDialogs()
  const toast = useToast()
  const today = dayIndex(Date.now(), settings.dayCutoff)
  const status = (c: Card) => {
    if (c.suspended) return 'Приостановлена'
    if (c.state === CardState.New) return 'Новая'
    if (c.state === CardState.Review) return `Повтор ${relativeDays(dayIndex(c.due, settings.dayCutoff) - today)} · интервал ${formatDays(c.scheduledDays)}`
    return 'В изучении'
  }
  return (
    <Section title={type.kind === 'cloze' ? 'Карточки (пропуски)' : 'Карточки'}>
      <div className="group">
        {cards.map((c) => (
          <div key={c.id} className="row-wrap">
            <div className="row card-info">
              <span className="row__body">
                <span className="row__title">{type.kind === 'cloze' ? `Пропуск ${c.ord + 1}` : (type.templates[c.ord]?.name ?? `Карточка ${c.ord + 1}`)}</span>
                <span className="row__sub">
                  {status(c)} · повторений: {c.reps}
                  {c.lapses ? `, забыто: ${c.lapses}` : ''}
                </span>
              </span>
              <button
                type="button"
                className="btn btn--small btn--tinted"
                aria-label={`${c.suspended ? 'Возобновить' : 'Приостановить'}: карточка ${c.ord + 1}`}
                onClick={() => void setSuspended([c.id], !c.suspended)}
              >
                {c.suspended ? 'Возобновить' : 'Пауза'}
              </button>
              {c.state !== CardState.New && (
                <button
                  type="button"
                  className="btn btn--small btn--tinted"
                  aria-label={`Сбросить прогресс: карточка ${c.ord + 1}`}
                  onClick={async () => {
                    const ok = await dialogs.confirm({
                      title: 'Сбросить прогресс?',
                      message: 'Карточка снова станет новой. История ответов останется в статистике.',
                      ok: 'Сбросить',
                      cancel: 'Оставить',
                      danger: true,
                    })
                    if (!ok) return
                    await forgetCards([c.id])
                    toast.show('Карточка снова новая')
                  }}
                >
                  Сбросить
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ── Form ──────────────────────────────────────────────────────────────────────

function EditorForm({ ed, noteId, onDeleted }: { ed: Editor; noteId?: number; onDeleted?: () => void }) {
  const dialogs = useDialogs()
  const toast = useToast()
  const [typeOpen, setTypeOpen] = useState(false)
  const [deckOpen, setDeckOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const active = useRef(0)
  const els = useRef<(HTMLDivElement | null)[]>([])
  const type = ed.type
  const deck = ed.data?.decks.find((d) => d.id === ed.deckId)

  if (!type || !ed.data) return null

  const focusActive = () => {
    const el = els.current[active.current]
    el?.focus({ preventScroll: true })
    return el
  }

  const exec = (cmd: string) => {
    focusActive()
    document.execCommand(cmd, false)
    const el = els.current[active.current]
    if (el) ed.setField(active.current, el.innerHTML)
  }

  const maxCloze = Math.max(0, ...clozeNumbers(ed.fields.map((f) => dehydrateMediaHtml(f)).join(' ')))

  const cloze = (n: number) => {
    const el = focusActive()
    if (!el) return
    const sel = window.getSelection()
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null
    if (!range || !el.contains(range.commonAncestorContainer)) {
      // No selection inside the field: append an empty deletion at the end.
      el.innerHTML += `{{c${n}::}}`
    } else {
      const div = document.createElement('div')
      div.appendChild(range.cloneContents())
      const inner = div.innerHTML
      document.execCommand('insertHTML', false, `{{c${n}::${inner}}}`)
      if (!inner) {
        const s = window.getSelection() as Selection & { modify?: (a: string, d: string, g: string) => void }
        s.modify?.('move', 'backward', 'character')
        s.modify?.('move', 'backward', 'character')
      }
    }
    ed.setField(active.current, el.innerHTML)
  }

  const addImage = async () => {
    const el = els.current[active.current]
    const sel = window.getSelection()
    const saved = sel && sel.rangeCount && el?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null
    const file = await pickFile('image/*')
    if (!file || !el) return
    el.focus({ preventScroll: true })
    if (saved) {
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(saved)
    } else {
      const r = document.createRange()
      r.selectNodeContents(el)
      r.collapse(false)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(r)
    }
    try {
      await insertImageFile(file)
      ed.setField(active.current, el.innerHTML)
    } catch {
      toast.show('Не удалось добавить изображение')
    }
  }

  const removeNote = async () => {
    if (noteId == null) return
    const n = ed.data?.cards.length ?? 0
    const ok = await dialogs.confirm({
      title: 'Удалить запись?',
      message: `Будет удалена запись и ${count(n, CARDS)}. Отменить нельзя.`,
      ok: 'Удалить',
      cancel: 'Оставить',
      danger: true,
    })
    if (!ok) return
    await deleteNotes([noteId])
    toast.show('Запись удалена')
    onDeleted?.()
  }

  const mod = isApplePlatform() ? '⌘' : 'Ctrl'
  const tool = (label: string, icon: React.ReactNode, onClick: () => void, extra = '') => (
    <button
      type="button"
      className={`tool${extra}`}
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  )

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="Форматирование">
        {type.kind === 'cloze' && (
          <>
            {tool(`Новый пропуск c${maxCloze + 1}`, <span>[c{maxCloze + 1}]</span>, () => cloze(maxCloze + 1), ' tool--accent')}
            {maxCloze > 0 && tool(`Пропуск с тем же номером c${maxCloze}`, <span>[c{maxCloze}]</span>, () => cloze(maxCloze), ' tool--accent')}
          </>
        )}
        {tool('Жирный', <Bold size={18} aria-hidden />, () => exec('bold'))}
        {tool('Курсив', <Italic size={18} aria-hidden />, () => exec('italic'))}
        {tool('Подчёркнутый', <Underline size={18} aria-hidden />, () => exec('underline'))}
        {tool('Изображение', <ImagePlus size={18} aria-hidden />, () => void addImage())}
        {tool('Убрать форматирование', <Eraser size={18} aria-hidden />, () => exec('removeFormat'))}
        {tool('Просмотр карточки', <Eye size={18} aria-hidden />, () => setPreviewOpen(true))}
      </div>

      <div className="group editor-meta">
        <button type="button" className="row" onClick={() => setTypeOpen(true)}>
          <span className="row__body">
            <span className="row__title">Тип</span>
          </span>
          <span className="row__value">{type.name}</span>
        </button>
        <button type="button" className="row" onClick={() => setDeckOpen(true)}>
          <span className="row__body">
            <span className="row__title">Колода</span>
          </span>
          <span className="row__value">{deck ? leafName(deck.name) : 'Моя колода (новая)'}</span>
        </button>
      </div>

      <div className="editor-fields" key={ed.formKey}>
        {type.fields.map((f, i) => {
          const id = `field-${i}`
          const errId = i === 0 && ed.error ? 'editor-error' : undefined
          const dupId = i === 0 && ed.dupes > 0 ? 'editor-dupe' : undefined
          return (
            <div className="field" key={`${type.id}-${i}`}>
              <div className="field__label">
                <span id={`${id}-label`} onClick={() => els.current[i]?.focus()}>
                  {f.name}
                </span>
                {ed.isNew && (
                  <button
                    type="button"
                    className={`pin-btn${ed.sticky[i] ? ' pin-btn--on' : ''}`}
                    aria-pressed={ed.sticky[i] ?? false}
                    aria-label={`Закрепить поле «${f.name}» — не очищать после добавления`}
                    title="Закрепить: не очищать после добавления"
                    onClick={() => ed.toggleSticky(i)}
                  >
                    <Pin size={16} aria-hidden />
                  </button>
                )}
              </div>
              <RichField
                id={id}
                value={ed.fields[i] ?? ''}
                labelledBy={`${id}-label`}
                placeholder={i === 0 ? (type.kind === 'cloze' ? 'Текст с пропусками' : 'Что нужно вспомнить?') : 'Необязательно'}
                autoFocus={ed.isNew && i === 0}
                invalid={i === 0 && !!ed.error}
                describedBy={[errId, dupId].filter(Boolean).join(' ') || undefined}
                onFocus={() => (active.current = i)}
                onChange={(html) => ed.setField(i, html)}
                elRef={(el) => (els.current[i] = el)}
              />
              {i === 0 && ed.error && (
                <p className="field__error" id="editor-error" role="alert">
                  {ed.error}
                </p>
              )}
              {i === 0 && ed.dupes > 0 && !ed.error && (
                <p className="field__hint" id="editor-dupe">
                  Похожая запись уже есть ({ed.dupes}). Можно сохранить и её.
                </p>
              )}
            </div>
          )
        })}
        <div className="field">
          <label className="field__label" htmlFor="tag-input">
            Метки
          </label>
          <TagInput tags={ed.tags} onChange={ed.setTags} />
        </div>
        <p className="section__foot hide-touch">
          <span className="kbd">{mod} Enter</span> — {ed.isNew ? 'добавить' : 'сохранить'}
        </p>
      </div>

      {!ed.isNew && ed.data.cards.length > 0 && <CardsInfo type={type} cards={ed.data.cards} />}
      {!ed.isNew && (
        <Section>
          <div className="group">
            <ButtonRow onClick={() => void removeNote()} tone="danger" icon={<Trash2 size={18} />} iconColor="var(--danger)" title="Удалить запись" />
          </div>
        </Section>
      )}

      <TypePicker open={typeOpen} onClose={() => setTypeOpen(false)} types={ed.data.types} value={ed.typeId} onPick={ed.changeType} />
      <DeckPicker open={deckOpen} onClose={() => setDeckOpen(false)} decks={ed.data.decks} value={ed.deckId} onPick={ed.setDeckId} />
      <PreviewSheet open={previewOpen} onClose={() => setPreviewOpen(false)} ed={ed} />
    </>
  )
}

function useSaveShortcut(save: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [save])
}

function useDiscardGuard(ed: Editor) {
  const dialogs = useDialogs()
  return async () => {
    const hasContent = ed.isNew ? ed.fields.some((f) => !isFieldEmpty(f)) : ed.dirty
    if (!hasContent) return true
    return dialogs.confirm({
      title: ed.isNew ? 'Не добавлять карточку?' : 'Не сохранять изменения?',
      message: 'Введённый текст пропадёт.',
      ok: 'Не сохранять',
      cancel: 'Продолжить',
      danger: true,
    })
  }
}

// ── Screens ───────────────────────────────────────────────────────────────────

export default function EditorScreen({ noteId, deckId }: { noteId?: number; deckId?: number }) {
  const ed = useEditor(noteId, deckId)
  const [added, setAdded] = useState(0)
  const backTo = noteId != null ? '/browse' : deckId != null ? `/deck/${deckId}` : '/'
  const { save, saving } = useSave(ed, noteId, (kind) => {
    if (kind === 'saved') goBack(backTo)
    else setAdded((n) => n + 1)
  })
  useSaveShortcut(() => void save())
  const guard = useDiscardGuard(ed)

  if (!ed.data || !ed.ready) return <Loading />
  if (noteId != null && !ed.data.note) {
    return (
      <Screen title="Запись не найдена" back={{ label: 'Назад', fallback: '/browse' }}>
        <p className="muted">Возможно, её удалили.</p>
      </Screen>
    )
  }
  const title = ed.isNew ? 'Новая карточка' : 'Изменить запись'
  return (
    <Screen
      title={title}
      large={false}
      back={{
        label: ed.isNew ? (added > 0 ? 'Готово' : 'Отмена') : 'Назад',
        fallback: backTo,
        onClick: async () => {
          if (await guard()) goBack(backTo)
        },
      }}
      actions={
        <button type="button" className="nav-btn nav-btn--strong" onClick={() => void save()} disabled={saving}>
          {ed.isNew ? 'Добавить' : 'Готово'}
        </button>
      }
    >
      <EditorForm ed={ed} noteId={noteId} onDeleted={() => goBack(backTo)} />
      <div className="spacer" />
    </Screen>
  )
}

/** Editor in a sheet over the study screen. */
export function NoteEditorSheet({ noteId, onClose }: { noteId: number; onClose: () => void }) {
  const ed = useEditor(noteId, undefined)
  const { save, saving } = useSave(ed, noteId, () => onClose())
  const guard = useDiscardGuard(ed)
  useSaveShortcut(() => void save())
  return (
    <Sheet
      open
      onClose={onClose}
      title="Изменить запись"
      full
      confirmClose={guard}
      start={
        <button type="button" className="nav-btn" onClick={async () => (await guard()) && onClose()}>
          Отмена
        </button>
      }
      end={
        <button type="button" className="nav-btn nav-btn--strong" onClick={() => void save()} disabled={saving || !ed.ready}>
          Готово
        </button>
      }
    >
      {!ed.data || !ed.ready ? <Loading /> : <EditorForm ed={ed} noteId={noteId} onDeleted={onClose} />}
    </Sheet>
  )
}
