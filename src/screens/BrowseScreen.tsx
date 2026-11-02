import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowUpDown, CircleHelp, FolderInput, Flag, Pause, Play, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { Screen } from '../ui/Screen'
import { Sheet } from '../ui/Sheet'
import { useDialogs } from '../ui/Dialogs'
import { useToast } from '../ui/Toast'
import { DeckBadge, EmptyState, Loading } from '../ui/controls'
import { db } from '../db/db'
import { deleteCards, forgetCards, leafName, moveCards, setFlag, setSuspended } from '../db/repo'
import { useSettings } from '../db/settings'
import { CardState, type Card, type Deck, type Note, type NoteType } from '../db/types'
import { renderCard } from '../render/card'
import { plainText } from '../render/html'
import { dayIndex } from '../sched/day'
import { compileSearch, SEARCH_HELP, type SearchCtx } from '../lib/search'
import { href } from '../lib/router'
import { CARDS, count, formatNumber, relativeDays } from '../lib/format'
import { FLAG_COLORS, FLAG_NAMES } from './StudyScreen'

type Sort = 'added-desc' | 'added-asc' | 'due' | 'interval' | 'alpha' | 'difficulty' | 'lapses'

const SORTS: { value: Sort; label: string }[] = [
  { value: 'added-desc', label: 'Сначала новые записи' },
  { value: 'added-asc', label: 'Сначала старые записи' },
  { value: 'due', label: 'По сроку повторения' },
  { value: 'interval', label: 'По интервалу' },
  { value: 'difficulty', label: 'Сначала трудные' },
  { value: 'lapses', label: 'Чаще забываемые' },
  { value: 'alpha', label: 'По алфавиту' },
]

const FILTERS: { key: string; label: string; q: string }[] = [
  { key: 'all', label: 'Все', q: '' },
  { key: 'due', label: 'К повторению', q: 'is:due' },
  { key: 'new', label: 'Новые', q: 'is:new' },
  { key: 'learn', label: 'В изучении', q: 'is:learn' },
  { key: 'suspended', label: 'Приостановлены', q: 'is:suspended' },
  { key: 'flag', label: 'С флагом', q: '-flag:0' },
  { key: 'leech', label: 'Трудные', q: 'is:leech' },
]

const PAGE = 80

interface Collection {
  cards: Card[]
  notes: Map<number, Note>
  types: Map<number, NoteType>
  decks: Map<number, Deck>
}

function useCollection(): Collection | undefined {
  return useLiveQuery(async () => {
    const [cards, notes, types, decks] = await Promise.all([db.cards.toArray(), db.notes.toArray(), db.noteTypes.toArray(), db.decks.toArray()])
    return {
      cards,
      notes: new Map(notes.map((n) => [n.id, n])),
      types: new Map(types.map((t) => [t.id, t])),
      decks: new Map(decks.map((d) => [d.id, d])),
    }
  }, [])
}

function sortKey(sort: Sort, c: Card, note: Note): number | string {
  switch (sort) {
    case 'added-desc':
      return -note.createdAt * 100 - c.ord
    case 'added-asc':
      return note.createdAt * 100 + c.ord
    case 'due':
      return c.state === CardState.New ? Number.MAX_SAFE_INTEGER : c.due
    case 'interval':
      return -c.scheduledDays
    case 'difficulty':
      return -c.difficulty
    case 'lapses':
      return -c.lapses
    case 'alpha':
      return plainText(note.fields[0] ?? '').toLowerCase()
  }
}

function CardRow({
  card,
  col,
  selecting,
  selected,
  onToggle,
  today,
  cutoff,
}: {
  card: Card
  col: Collection
  selecting: boolean
  selected: boolean
  onToggle: () => void
  today: number
  cutoff: number
}) {
  const note = col.notes.get(card.noteId)
  const type = note ? col.types.get(note.typeId) : undefined
  const deck = col.decks.get(card.deckId)
  const { q, a } = useMemo(() => {
    if (!note || !type) return { q: '', a: '' }
    const r = renderCard(type, note, card, deck?.name ?? '')
    const qt = plainText(r.question.replace(/<button[^>]*><\/button>/g, ''))
    let at = plainText(r.answer.replace(/<button[^>]*><\/button>/g, ''))
    if (at.startsWith(qt)) at = at.slice(qt.length).trim()
    return { q: qt || '(пусто)', a: at }
  }, [note, type, card, deck])
  let status: string
  if (card.suspended) status = 'Приостановлена'
  else if (card.buriedDay === today) status = 'Скрыта до завтра'
  else if (card.state === CardState.New) status = 'Новая'
  else if (card.state === CardState.Review) status = `Повтор ${relativeDays(dayIndex(card.due, cutoff) - today)}`
  else status = 'В изучении'
  const multi = type && (type.kind === 'cloze' || type.templates.length > 1)
  const body = (
    <>
      {selecting && (
        <span className={`check${selected ? ' check--on' : ''}`} aria-hidden>
          ✓
        </span>
      )}
      <span className="row__body">
        <span className="row__title browse-q">{q}</span>
        {a && <span className="row__sub browse-a">{a}</span>}
        <span className="browse-meta">
          {card.flag > 0 && <i className="flag-dot" style={{ ['--flag' as string]: FLAG_COLORS[card.flag] }} aria-label={`${FLAG_NAMES[card.flag]} флаг`} />}
          {deck && <span>{leafName(deck.name)}</span>}
          {multi && <span>{type!.kind === 'cloze' ? `c${card.ord + 1}` : type!.templates[card.ord]?.name}</span>}
          <span className={card.state === CardState.New ? 'count--new' : card.suspended ? '' : card.state === CardState.Review ? 'count--review' : 'count--learn'}>
            {status}
          </span>
        </span>
      </span>
    </>
  )
  if (selecting) {
    return (
      <button type="button" className="row browse-row" aria-pressed={selected} onClick={onToggle}>
        {body}
      </button>
    )
  }
  return (
    <a className="row browse-row" href={href(`/note/${card.noteId}`)}>
      {body}
    </a>
  )
}

export default function BrowseScreen({ deckId, initialQuery }: { deckId?: number; initialQuery: string }) {
  const col = useCollection()
  const settings = useSettings()
  const dialogs = useDialogs()
  const toast = useToast()
  const [query, setQuery] = useState(initialQuery)
  const deferred = useDeferredValue(query)
  const [filter, setFilter] = useState('all')
  const [deckFilter, setDeckFilter] = useState<number | null>(deckId ?? null)
  const [sort, setSort] = useState<Sort>('added-desc')
  const [limit, setLimit] = useState(PAGE)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [sheet, setSheet] = useState<null | 'sort' | 'deck' | 'help' | 'move' | 'flag'>(null)
  const more = useRef<HTMLDivElement>(null)

  useEffect(() => setLimit(PAGE), [deferred, filter, deckFilter, sort])

  const now = Date.now()
  const today = dayIndex(now, settings.dayCutoff)
  const deckName = deckFilter != null ? col?.decks.get(deckFilter)?.name : undefined

  const results = useMemo(() => {
    if (!col) return []
    const f = FILTERS.find((x) => x.key === filter)?.q ?? ''
    const deckQ = deckName ? `deck:"${deckName}"` : ''
    const pred = compileSearch([deferred, f, deckQ].filter(Boolean).join(' '))
    const ctx: SearchCtx = { card: null as unknown as Card, note: null as unknown as Note, deckName: '', today, now, cutoff: settings.dayCutoff }
    const out: { card: Card; key: number | string }[] = []
    for (const card of col.cards) {
      const note = col.notes.get(card.noteId)
      if (!note) continue
      ctx.card = card
      ctx.note = note
      ctx.deckName = col.decks.get(card.deckId)?.name ?? ''
      if (pred(ctx)) out.push({ card, key: sortKey(sort, card, note) })
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return out.map((x) => x.card)
    // `now` changes every render; the day is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [col, deferred, filter, deckName, sort, today, settings.dayCutoff])

  // Infinite scroll.
  useEffect(() => {
    const el = more.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setLimit((l) => l + PAGE), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [results.length, limit])

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const ids = [...selected]
  const allSuspended = ids.length > 0 && ids.every((id) => col?.cards.find((c) => c.id === id)?.suspended)
  const finish = (msg: string) => {
    toast.show(msg)
    setSelected(new Set())
    setSelecting(false)
  }

  const bulkDelete = async () => {
    const ok = await dialogs.confirm({
      title: `Удалить ${count(ids.length, CARDS)}?`,
      message: 'Записи, у которых не останется карточек, тоже будут удалены. Отменить нельзя.',
      ok: 'Удалить',
      cancel: 'Оставить',
      danger: true,
    })
    if (!ok) return
    await deleteCards(ids)
    finish(`Удалено: ${count(ids.length, CARDS)}`)
  }

  const bulkForget = async () => {
    const ok = await dialogs.confirm({
      title: `Сбросить прогресс ${count(ids.length, ['карточки', 'карточек', 'карточек'])}?`,
      message: 'Они снова станут новыми. История ответов останется в статистике.',
      ok: 'Сбросить',
      cancel: 'Оставить',
      danger: true,
    })
    if (!ok) return
    await forgetCards(ids)
    finish('Прогресс сброшен')
  }

  const decks = col ? [...col.decks.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')) : []

  return (
    <Screen
      title="Карточки"
      subtitle={col ? `${formatNumber(results.length)} из ${formatNumber(col.cards.length)}` : undefined}
      actions={
        col && col.cards.length > 0 ? (
          <button
            type="button"
            className="nav-btn"
            onClick={() => {
              setSelecting((s) => !s)
              setSelected(new Set())
            }}
          >
            {selecting ? 'Готово' : 'Выбрать'}
          </button>
        ) : undefined
      }
    >
      {!col ? (
        <Loading />
      ) : col.cards.length === 0 ? (
        <EmptyState icon={<Search size={40} />} title="Карточек пока нет" text="Добавьте первую карточку или импортируйте колоду.">
          <a className="btn" href={href('/add')}>
            Новая карточка
          </a>
          <a className="btn btn--tinted" href={href('/import')}>
            Импорт
          </a>
        </EmptyState>
      ) : (
        <>
          <div className="browse-tools">
            <div className="search">
              <Search className="search__icon" size={18} aria-hidden />
              <label className="sr-only" htmlFor="browse-q">
                Поиск карточек
              </label>
              <input
                id="browse-q"
                className="input input--search"
                type="search"
                value={query}
                placeholder="Поиск: слово, tag:метка, is:due…"
                autoCapitalize="off"
                autoCorrect="off"
                enterKeyHint="search"
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button type="button" className="icon-btn search__clear" aria-label="Очистить поиск" onClick={() => setQuery('')}>
                  <X size={18} aria-hidden />
                </button>
              )}
            </div>
            <div className="browse-tools__row">
              <button type="button" className="chip" onClick={() => setSheet('deck')} aria-label={`Колода: ${deckName ? leafName(deckName) : 'все'}`}>
                {deckName ? leafName(deckName) : 'Все колоды'} ▾
              </button>
              <button type="button" className="icon-btn" aria-label="Сортировка" onClick={() => setSheet('sort')}>
                <ArrowUpDown size={20} aria-hidden />
              </button>
              <button type="button" className="icon-btn" aria-label="Как искать" onClick={() => setSheet('help')}>
                <CircleHelp size={20} aria-hidden />
              </button>
            </div>
            <div className="chips" role="group" aria-label="Фильтр">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {results.length === 0 ? (
            <EmptyState icon={<Search size={40} />} title="Ничего не найдено" text="Измените запрос или фильтр." />
          ) : (
            <div className="group browse-list">
              {results.slice(0, limit).map((c) => (
                <CardRow
                  key={c.id}
                  card={c}
                  col={col}
                  selecting={selecting}
                  selected={selected.has(c.id)}
                  onToggle={() => toggle(c.id)}
                  today={today}
                  cutoff={settings.dayCutoff}
                />
              ))}
            </div>
          )}
          {limit < results.length && <div ref={more} className="list-more" aria-hidden />}
          {selecting && <div style={{ height: 72 }} />}
        </>
      )}

      {selecting && (
        <div className="action-bar" role="toolbar" aria-label="Действия с выбранными">
          <div className="action-bar__inner">
            <span className="action-bar__count">
              {ids.length ? `Выбрано: ${ids.length}` : (
                <button type="button" className="btn btn--small btn--plain" onClick={() => setSelected(new Set(results.slice(0, 2000).map((c) => c.id)))}>
                  Выбрать все
                </button>
              )}
            </span>
            <button type="button" className="icon-btn" disabled={!ids.length} aria-label="Переместить в колоду" onClick={() => setSheet('move')}>
              <FolderInput size={22} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={!ids.length}
              aria-label={allSuspended ? 'Возобновить' : 'Приостановить'}
              onClick={async () => {
                await setSuspended(ids, !allSuspended)
                finish(allSuspended ? 'Возобновлено' : 'Приостановлено')
              }}
            >
              {allSuspended ? <Play size={22} aria-hidden /> : <Pause size={22} aria-hidden />}
            </button>
            <button type="button" className="icon-btn" disabled={!ids.length} aria-label="Флаг" onClick={() => setSheet('flag')}>
              <Flag size={22} aria-hidden />
            </button>
            <button type="button" className="icon-btn" disabled={!ids.length} aria-label="Сбросить прогресс" onClick={() => void bulkForget()}>
              <RotateCcw size={22} aria-hidden />
            </button>
            <button type="button" className="icon-btn" disabled={!ids.length} aria-label="Удалить" style={{ color: ids.length ? 'var(--danger)' : undefined }} onClick={() => void bulkDelete()}>
              <Trash2 size={22} aria-hidden />
            </button>
          </div>
        </div>
      )}

      <Sheet open={sheet === 'sort'} onClose={() => setSheet(null)} title="Сортировка">
        <div className="group">
          {SORTS.map((s) => (
            <button
              key={s.value}
              type="button"
              className="row"
              aria-pressed={sort === s.value}
              onClick={() => {
                setSort(s.value)
                setSheet(null)
              }}
            >
              <span className={`check${sort === s.value ? ' check--on' : ''}`} aria-hidden>
                ✓
              </span>
              <span className="row__body">{s.label}</span>
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={sheet === 'deck' || sheet === 'move'} onClose={() => setSheet(null)} title={sheet === 'move' ? `Переместить ${count(ids.length, ['карточку', 'карточки', 'карточек'])}` : 'Колода'}>
        <div className="group">
          {sheet === 'deck' && (
            <button
              type="button"
              className="row"
              aria-pressed={deckFilter == null}
              onClick={() => {
                setDeckFilter(null)
                setSheet(null)
              }}
            >
              <span className={`check${deckFilter == null ? ' check--on' : ''}`} aria-hidden>
                ✓
              </span>
              <span className="row__body">Все колоды</span>
            </button>
          )}
          {decks.map((d) => {
            const on = sheet === 'deck' && deckFilter === d.id
            return (
              <button
                key={d.id}
                type="button"
                className="row"
                style={{ paddingLeft: `calc(var(--s-4) + ${(d.name.split('::').length - 1) * 20}px)` }}
                aria-pressed={on}
                onClick={async () => {
                  if (sheet === 'deck') {
                    setDeckFilter(d.id)
                    setSheet(null)
                  } else {
                    await moveCards(ids, d.id)
                    setSheet(null)
                    finish(`Перемещено в «${leafName(d.name)}»`)
                  }
                }}
              >
                {sheet === 'deck' && (
                  <span className={`check${on ? ' check--on' : ''}`} aria-hidden>
                    ✓
                  </span>
                )}
                <DeckBadge color={d.color} emoji={d.emoji} name={leafName(d.name)} size="small" />
                <span className="row__body">{leafName(d.name)}</span>
              </button>
            )
          })}
        </div>
      </Sheet>

      <Sheet open={sheet === 'flag'} onClose={() => setSheet(null)} title="Флаг">
        <div className="group">
          {FLAG_NAMES.map((name, i) => (
            <button
              key={i}
              type="button"
              className="row"
              onClick={async () => {
                await setFlag(ids, i)
                setSheet(null)
                finish(i ? `Флаг: ${name.toLowerCase()}` : 'Флаг снят')
              }}
            >
              <i className="flag-dot" style={{ ['--flag' as string]: FLAG_COLORS[i] || 'var(--surface-3)' }} aria-hidden />
              <span className="row__body">{name}</span>
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={sheet === 'help'} onClose={() => setSheet(null)} title="Как искать">
        <div className="group">
          {SEARCH_HELP.map(([q, d]) => (
            <button
              key={q}
              type="button"
              className="row"
              onClick={() => {
                setQuery(q.split(' · ')[0])
                setSheet(null)
              }}
            >
              <span className="row__body">
                <span className="row__title">
                  <code className="code-inline">{q}</code>
                </span>
                <span className="row__sub">{d}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="section__foot">Условия объединяются через пробел. Нажмите на пример, чтобы подставить его.</p>
      </Sheet>
    </Screen>
  )
}

