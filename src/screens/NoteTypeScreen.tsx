import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Screen, Section } from '../ui/Screen'
import { useDialogs } from '../ui/Dialogs'
import { useToast } from '../ui/Toast'
import { ButtonRow, Loading, Segmented } from '../ui/controls'
import { CardView } from '../ui/CardView'
import { db } from '../db/db'
import { deleteNoteType, saveNoteType, type EditedField, type EditedTemplate } from '../db/repo'
import { useSettings } from '../db/settings'
import type { Note, NoteType } from '../db/types'
import { renderCard } from '../render/card'
import { renameFieldRefs } from '../render/template'
import { goBack, navigate } from '../lib/router'
import { useIsDark } from '../lib/theme'
import { CARDS, count, NOTES } from '../lib/format'

export default function NoteTypeScreen({ typeId }: { typeId: number }) {
  const data = useLiveQuery(async () => {
    const type = await db.noteTypes.get(typeId)
    const notes = await db.notes.where('typeId').equals(typeId).limit(1).toArray()
    const total = await db.notes.where('typeId').equals(typeId).count()
    return { type: type ?? null, sample: notes[0] ?? null, total }
  }, [typeId])
  if (data === undefined) return <Loading />
  if (!data.type) {
    return (
      <Screen title="Тип не найден" back={{ label: 'Типы', fallback: '/settings/notetypes' }}>
        <p className="muted">Возможно, его удалили.</p>
      </Screen>
    )
  }
  return <Editor key={data.type.updatedAt} type={data.type} sample={data.sample} total={data.total} />
}

function Editor({ type, sample, total }: { type: NoteType; sample: Note | null; total: number }) {
  const dialogs = useDialogs()
  const toast = useToast()
  const dark = useIsDark()
  const settings = useSettings()
  const [name, setName] = useState(type.name)
  const [css, setCss] = useState(type.css)
  const [fields, setFields] = useState<EditedField[]>(type.fields.map((f, i) => ({ ...f, origin: i })))
  const [templates, setTemplates] = useState<EditedTemplate[]>(type.templates.map((t, i) => ({ ...t, origin: i })))
  const [tab, setTab] = useState(0)
  const [side, setSide] = useState<'q' | 'a'>('q')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  useEffect(() => setTab((t) => Math.min(t, templates.length - 1)), [templates.length])

  const touch = () => setDirty(true)
  const tmpl = templates[tab]

  const previewNote: Note = useMemo(() => {
    const vals = fields.map((f) => (sample && f.origin != null ? (sample.fields[f.origin] ?? '') : `«${f.name}»`))
    if (type.kind === 'cloze' && !sample) vals[0] = 'Пример: {{c1::пропуск}} в тексте'
    return { id: 0, typeId: type.id, guid: '', fields: vals, tags: sample?.tags ?? [], searchText: '', createdAt: 0, updatedAt: 0 }
  }, [fields, sample, type.kind, type.id])

  const draft: NoteType = { ...type, name, css, fields: fields.map(({ name: n, sticky }) => ({ name: n, sticky })), templates: templates.map(({ name: n, qfmt, afmt }) => ({ name: n, qfmt, afmt })) }
  const rendered = tmpl ? renderCard(draft, previewNote, { ord: type.kind === 'cloze' ? 0 : tab, flag: 0 }, 'Колода') : null

  const save = async () => {
    const names = fields.map((f) => f.name.trim())
    if (names.some((n) => !n)) return toast.show('У каждого поля должно быть название')
    if (new Set(names).size !== names.length) return toast.show('Названия полей должны различаться')
    if (/[:{}"]/.test(names.join(''))) return toast.show('В названиях полей нельзя использовать : { } "')
    const removedFields = type.fields.filter((_, i) => !fields.some((f) => f.origin === i))
    const removedTemplates = type.templates.filter((_, i) => !templates.some((t) => t.origin === i))
    if ((removedFields.length || removedTemplates.length) && total > 0) {
      const parts = [
        removedFields.length ? `поля ${removedFields.map((f) => `«${f.name}»`).join(', ')} и их содержимое` : '',
        removedTemplates.length ? `карточки шаблонов ${removedTemplates.map((t) => `«${t.name}»`).join(', ')} с историей` : '',
      ].filter(Boolean)
      const ok = await dialogs.confirm({
        title: 'Удалить данные из записей?',
        message: `У ${count(total, ['записи', 'записей', 'записей'])} будут удалены ${parts.join(', а также ')}.`,
        ok: 'Сохранить',
        cancel: 'Отмена',
        danger: true,
      })
      if (!ok) return
    }
    setSaving(true)
    try {
      // Renamed fields: update their references in the templates in one pass (swaps and chains included).
      const renames = new Map<string, string>()
      for (const f of fields) {
        const oldName = f.origin != null ? type.fields[f.origin]?.name : undefined
        if (oldName && oldName !== f.name.trim()) renames.set(oldName, f.name.trim())
      }
      const rename = (src: string) => renameFieldRefs(src, renames)
      const tpls = templates.map((t) => ({ ...t, qfmt: rename(t.qfmt), afmt: rename(t.afmt) }))
      const res = await saveNoteType(type.id, { name, css, fields, templates: tpls })
      setDirty(false)
      const extra = [res.cardsAdded ? `новых карточек: ${res.cardsAdded}` : '', res.cardsRemoved ? `удалено: ${count(res.cardsRemoved, CARDS)}` : ''].filter(Boolean).join(', ')
      toast.show(extra ? `Сохранено (${extra})` : 'Сохранено')
    } catch (e) {
      toast.show((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (total > 0) {
      await dialogs.alert({ title: 'Нельзя удалить', message: `Этим типом пользуются ${count(total, NOTES)}. Сначала удалите их.` })
      return
    }
    const ok = await dialogs.confirm({ title: `Удалить тип «${type.name}»?`, ok: 'Удалить', cancel: 'Оставить', danger: true })
    if (!ok) return
    await deleteNoteType(type.id)
    navigate('/settings/notetypes', { replace: true })
  }

  const back = async () => {
    if (dirty) {
      const ok = await dialogs.confirm({ title: 'Не сохранять изменения?', ok: 'Не сохранять', cancel: 'Продолжить', danger: true })
      if (!ok) return
    }
    goBack('/settings/notetypes')
  }

  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= fields.length) return
    const copy = [...fields]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    setFields(copy)
    touch()
  }

  return (
    <Screen
      title={type.name}
      large={false}
      back={{ label: 'Типы', fallback: '/settings/notetypes', onClick: () => void back() }}
      actions={
        <button type="button" className="nav-btn nav-btn--strong" onClick={() => void save()} disabled={saving || !dirty}>
          Сохранить
        </button>
      }
    >
      <Section title="Название">
        <label className="sr-only" htmlFor="nt-name">
          Название типа
        </label>
        <input
          id="nt-name"
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            touch()
          }}
        />
      </Section>

      <Section
        title="Поля"
        footer="В шаблоне поле подставляется как {{Название}}."
        action={
          <button
            type="button"
            className="section__action"
            onClick={async () => {
              const n = await dialogs.prompt({ title: 'Новое поле', label: 'Название поля', ok: 'Добавить', validate: (v) => (fields.some((f) => f.name === v) ? 'Такое поле уже есть' : /[:{}"]/.test(v) ? 'Нельзя использовать : { } "' : null) })
              if (!n) return
              setFields([...fields, { name: n, origin: null }])
              touch()
            }}
          >
            <Plus size={16} className="inline-icon" aria-hidden /> Поле
          </button>
        }
      >
        <div className="group">
          {fields.map((f, i) => (
            <div className="row nt-field" key={`${f.origin ?? 'new'}-${i}`}>
              <label className="sr-only" htmlFor={`nt-f-${i}`}>
                Название поля {i + 1}
              </label>
              <input
                id={`nt-f-${i}`}
                className="input nt-field__input"
                value={f.name}
                onChange={(e) => {
                  const copy = [...fields]
                  copy[i] = { ...f, name: e.target.value }
                  setFields(copy)
                  touch()
                }}
              />
              <button type="button" className="icon-btn" aria-label={`Поднять поле «${f.name}»`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={18} aria-hidden />
              </button>
              <button type="button" className="icon-btn" aria-label={`Опустить поле «${f.name}»`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={18} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Удалить поле «${f.name}»`}
                disabled={fields.length <= 1}
                style={{ color: fields.length > 1 ? 'var(--danger)' : undefined }}
                onClick={() => {
                  setFields(fields.filter((_, j) => j !== i))
                  touch()
                }}
              >
                <Trash2 size={18} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Шаблоны карточек"
        action={
          type.kind !== 'cloze' ? (
            <button
              type="button"
              className="section__action"
              onClick={async () => {
                const n = await dialogs.prompt({ title: 'Новый шаблон', label: 'Название', value: `Карточка ${templates.length + 1}`, ok: 'Добавить' })
                if (!n) return
                const f0 = fields[0]?.name ?? 'Вопрос'
                const f1 = fields[1]?.name ?? f0
                setTemplates([...templates, { name: n, qfmt: `{{${f1}}}`, afmt: `{{FrontSide}}\n\n<hr id=answer>\n\n{{${f0}}}`, origin: null }])
                setTab(templates.length)
                touch()
              }}
            >
              <Plus size={16} className="inline-icon" aria-hidden /> Шаблон
            </button>
          ) : undefined
        }
      >
        {templates.length > 1 && (
          <div style={{ marginBottom: 'var(--s-3)' }}>
            <Segmented label="Шаблон" value={tab} options={templates.map((t, i) => ({ value: i, label: t.name || `№${i + 1}` }))} onChange={setTab} />
          </div>
        )}
        {tmpl && (
          <div className="group pad stack">
            {type.kind !== 'cloze' && (
              <div className="field">
                <label className="field__label" htmlFor="nt-tname">
                  Название шаблона
                </label>
                <input
                  id="nt-tname"
                  className="input"
                  value={tmpl.name}
                  onChange={(e) => {
                    const copy = [...templates]
                    copy[tab] = { ...tmpl, name: e.target.value }
                    setTemplates(copy)
                    touch()
                  }}
                />
              </div>
            )}
            <div className="field">
              <label className="field__label" htmlFor="nt-q">
                Лицевая сторона
              </label>
              <textarea
                id="nt-q"
                className="textarea textarea--code"
                value={tmpl.qfmt}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => {
                  const copy = [...templates]
                  copy[tab] = { ...tmpl, qfmt: e.target.value }
                  setTemplates(copy)
                  touch()
                }}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="nt-a">
                Оборотная сторона
              </label>
              <textarea
                id="nt-a"
                className="textarea textarea--code"
                value={tmpl.afmt}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => {
                  const copy = [...templates]
                  copy[tab] = { ...tmpl, afmt: e.target.value }
                  setTemplates(copy)
                  touch()
                }}
              />
              <p className="field__hint">
                {'{{FrontSide}}'} — лицевая сторона, {'{{type:Поле}}'} — ввод ответа, {'{{cloze:Поле}}'} — пропуски, {'{{#Поле}}…{{/Поле}}'} — показать, если поле заполнено.
              </p>
            </div>
            {templates.length > 1 && (
              <button
                type="button"
                className="btn btn--small btn--danger"
                onClick={() => {
                  setTemplates(templates.filter((_, i) => i !== tab))
                  touch()
                }}
              >
                <Trash2 size={16} aria-hidden /> Удалить шаблон «{tmpl.name}»
              </button>
            )}
          </div>
        )}
      </Section>

      <Section title="Оформление (CSS)">
        <label className="sr-only" htmlFor="nt-css">
          CSS карточек
        </label>
        <textarea
          id="nt-css"
          className="textarea textarea--code"
          value={css}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => {
            setCss(e.target.value)
            touch()
          }}
        />
      </Section>

      <Section title={sample ? 'Просмотр на первой записи' : 'Просмотр'}>
        <div className="stack">
          <Segmented
            label="Сторона"
            value={side}
            options={[
              { value: 'q', label: 'Вопрос' },
              { value: 'a', label: 'Ответ' },
            ]}
            onChange={setSide}
          />
          {rendered && (
            <div className="card-surface">
              <CardView html={side === 'q' ? rendered.question : rendered.answer} css={rendered.css} dark={dark} zoom={settings.cardFontScale} label="Просмотр карточки" />
            </div>
          )}
        </div>
      </Section>

      {!type.builtin && (
        <Section>
          <div className="group">
            <ButtonRow onClick={() => void remove()} tone="danger" icon={<Trash2 size={18} />} iconColor="var(--danger)" title="Удалить тип записи" />
          </div>
        </Section>
      )}
    </Screen>
  )
}
