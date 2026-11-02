import { useLiveQuery } from 'dexie-react-hooks'
import { Plus } from 'lucide-react'
import { Screen, Section } from '../ui/Screen'
import { useDialogs } from '../ui/Dialogs'
import { Loading } from '../ui/controls'
import { db } from '../db/db'
import { cloneNoteType } from '../db/repo'
import { href, navigate } from '../lib/router'
import { count, NOTES } from '../lib/format'

export default function NoteTypesScreen() {
  const dialogs = useDialogs()
  const data = useLiveQuery(async () => {
    const types = await db.noteTypes.toArray()
    const counts = new Map<number, number>()
    for (const t of types) counts.set(t.id, await db.notes.where('typeId').equals(t.id).count())
    types.sort((a, b) => (a.builtin ? 0 : 1) - (b.builtin ? 0 : 1) || a.name.localeCompare(b.name, 'ru'))
    return { types, counts }
  }, [])

  const add = async () => {
    if (!data) return
    const base = await dialogs.choose({
      title: 'Новый тип на основе…',
      options: data.types.map((t) => ({ label: t.name, value: t.id })),
    })
    if (base == null) return
    const src = data.types.find((t) => t.id === base)
    const name = await dialogs.prompt({ title: 'Название типа', label: 'Название', value: `${src?.name ?? 'Тип'} (копия)`, ok: 'Создать' })
    if (!name) return
    const id = await cloneNoteType(base, name)
    navigate(`/settings/notetype/${id}`)
  }

  return (
    <Screen
      title="Типы записей"
      large={false}
      back={{ label: 'Настройки', fallback: '/settings' }}
      actions={
        <button type="button" className="icon-btn icon-btn--filled" aria-label="Новый тип записи" onClick={() => void add()}>
          <Plus size={22} aria-hidden />
        </button>
      }
    >
      {!data ? (
        <Loading />
      ) : (
        <Section footer="Тип записи задаёт поля и шаблоны карточек. Колоды Anki приходят со своими типами — их тоже можно менять.">
          <div className="group">
            {data.types.map((t) => (
              <a key={t.id} className="row" href={href(`/settings/notetype/${t.id}`)}>
                <span className="row__body">
                  <span className="row__title">{t.name}</span>
                  <span className="row__sub">
                    {t.kind === 'cloze' ? 'Пропуски' : count(t.templates.length, ['шаблон', 'шаблона', 'шаблонов'])} · {t.fields.map((f) => f.name).join(', ')}
                  </span>
                </span>
                <span className="row__value">{count(data.counts.get(t.id) ?? 0, NOTES)}</span>
              </a>
            ))}
          </div>
        </Section>
      )}
    </Screen>
  )
}
