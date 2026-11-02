import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { BarChart3, FolderPlus, ListChecks, Plus, Settings2, SlidersHorizontal, Zap } from 'lucide-react'
import { Screen, Section } from '../ui/Screen'
import { ButtonRow, Counts, DeckBadge, EmptyState, LinkRow, Loading, StaticRow, Stepper } from '../ui/controls'
import { Sheet } from '../ui/Sheet'
import { estimateMinutes, useOverview } from '../data/overview'
import { db } from '../db/db'
import { isInSubtree, leafName, parentName } from '../db/repo'
import { CardState } from '../db/types'
import { dayIndex } from '../sched/day'
import { href, navigate } from '../lib/router'
import { CARDS, count, formatDate, formatNumber, relativeDays } from '../lib/format'
import { useNewDeckFlow } from './DecksScreen'

function useDeckStats(deckId: number, cutoff: number) {
  return useLiveQuery(async () => {
    const deck = await db.decks.get(deckId)
    if (!deck) return null
    const all = await db.decks.toArray()
    const ids = all.filter((d) => isInSubtree(d.name, deck.name)).map((d) => d.id)
    const cards = await db.cards.where('deckId').anyOf(ids).toArray()
    const today = dayIndex(Date.now(), cutoff)
    let fresh = 0
    let learning = 0
    let young = 0
    let mature = 0
    let suspended = 0
    let nextDue: number | null = null
    for (const c of cards) {
      if (c.suspended) {
        suspended++
        continue
      }
      if (c.state === CardState.New) fresh++
      else if (c.state === CardState.Review) {
        if (c.scheduledDays >= 21) mature++
        else young++
        const d = dayIndex(c.due, cutoff)
        if (d > today && (nextDue === null || d < nextDue)) nextDue = d
      } else learning++
    }
    return { total: cards.length, fresh, learning, young, mature, suspended, nextDue, today }
  }, [deckId, cutoff])
}

export default function DeckScreen({ deckId }: { deckId: number }) {
  const ov = useOverview()
  const node = ov?.byId.get(deckId)
  const stats = useDeckStats(deckId, ov?.settings.dayCutoff ?? 4)
  const newDeck = useNewDeckFlow()
  const [customOpen, setCustomOpen] = useState(false)
  const [extra, setExtra] = useState(10)

  if (!ov || stats === undefined) return <Loading />
  if (!node || !stats) {
    return (
      <Screen title="Колода не найдена" back={{ label: 'Колоды', fallback: '/' }}>
        <EmptyState icon={<ListChecks size={40} />} title="Колода не найдена" text="Возможно, её удалили." />
      </Screen>
    )
  }

  const { deck, counts } = node
  const name = leafName(deck.name)
  const parent = parentName(deck.name)
  const parentNode = parent ? ov.decks.find((d) => d.name === parent) : undefined
  const due = counts.new + counts.learn + counts.review
  const minutes = estimateMinutes(counts, ov.avgAnswerMs)

  return (
    <Screen
      title={name}
      subtitle={parent ? parent.split('::').join(' › ') : undefined}
      back={{ label: parentNode ? leafName(parentNode.name) : 'Колоды', fallback: parentNode ? `/deck/${parentNode.id}` : '/' }}
      actions={
        <a className="icon-btn" href={href(`/deck/${deck.id}/options`)} aria-label="Параметры колоды">
          <Settings2 size={22} aria-hidden />
        </a>
      }
    >
      <div className="deck-head">
        <DeckBadge color={deck.color} emoji={deck.emoji} name={name} size="large" />
        {deck.description ? <p className="deck-head__desc">{deck.description}</p> : <p className="deck-head__desc muted">{count(stats.total, CARDS)} в колоде</p>}
      </div>

      <div className="tiles" style={{ marginTop: 'var(--s-4)' }}>
        <div className="tile tile--new">
          <span className="tile__value">{counts.new}</span>
          <span className="tile__label">Новые</span>
        </div>
        <div className="tile tile--learn">
          <span className="tile__value">{counts.learn}</span>
          <span className="tile__label">В изучении</span>
        </div>
        <div className="tile tile--review">
          <span className="tile__value">{counts.review}</span>
          <span className="tile__label">Повторить</span>
        </div>
      </div>

      <div className="deck-cta">
        {due > 0 ? (
          <>
            <a className="btn btn--block" href={href(`/study/${deck.id}`)}>
              Учить · ≈ {minutes} мин
            </a>
          </>
        ) : (
          <div className="deck-cta__done">
            <p>
              <strong>На сегодня всё.</strong>{' '}
              {stats.total === 0
                ? 'В колоде пока нет карточек. Можно добавить их вручную или импортировать файл.'
                : stats.nextDue != null
                  ? `Следующее повторение ${relativeDays(stats.nextDue - stats.today)}.`
                  : stats.fresh > 0
                    ? 'Лимит новых карточек на сегодня исчерпан.'
                    : ''}
            </p>
          </div>
        )}
        <div className="btn-row">
          <a className={`btn${stats.total === 0 ? '' : ' btn--tinted'}`} href={href(`/add?deck=${deck.id}`)}>
            <Plus size={20} aria-hidden /> {stats.total === 0 ? 'Добавить первые карточки' : 'Добавить'}
          </a>
          {stats.total > 0 && (
            <button type="button" className="btn btn--tinted" onClick={() => setCustomOpen(true)}>
              <Zap size={20} aria-hidden /> Учить ещё
            </button>
          )}
        </div>
      </div>

      {node.children.length > 0 && (
        <Section title="Подколоды" id="subdecks">
          <div className="group">
            {node.children.map((ch) => (
              <a key={ch.deck.id} className="row deck-row" href={href(`/deck/${ch.deck.id}`)}>
                <DeckBadge color={ch.deck.color} emoji={ch.deck.emoji} name={leafName(ch.deck.name)} size="small" />
                <span className="row__body">
                  <span className="row__title">{leafName(ch.deck.name)}</span>
                  <span className="row__sub">{count(ch.total, CARDS)}</span>
                </span>
                <Counts n={ch.counts.new} l={ch.counts.learn} r={ch.counts.review} />
              </a>
            ))}
          </div>
        </Section>
      )}

      <Section title="Колода">
        <div className="group">
          <LinkRow to={`/browse?deck=${deck.id}`} icon={<ListChecks size={18} />} iconColor="#0A84FF" title="Карточки колоды" value={formatNumber(stats.total)} />
          <LinkRow to={`/stats?deck=${deck.id}`} icon={<BarChart3 size={18} />} iconColor="#34C759" title="Статистика" />
          <LinkRow to={`/deck/${deck.id}/options`} icon={<SlidersHorizontal size={18} />} iconColor="#8E8E93" title="Параметры и лимиты" />
          <ButtonRow onClick={() => void newDeck(deck.name)} icon={<FolderPlus size={18} />} iconColor="#FF9F0A" title="Новая подколода" />
        </div>
      </Section>

      {stats.total > 0 && (
        <Section title="Состав" footer="Зрелые — карточки с интервалом от 21 дня.">
          <div className="group">
            <StaticRow title="Новые" value={formatNumber(stats.fresh)} />
            <StaticRow title="В изучении" value={formatNumber(stats.learning)} />
            <StaticRow title="Молодые" value={formatNumber(stats.young)} />
            <StaticRow title="Зрелые" value={formatNumber(stats.mature)} />
            {stats.suspended > 0 && <StaticRow title="Приостановлены" value={formatNumber(stats.suspended)} />}
            {stats.nextDue != null && <StaticRow title="Ближайшее повторение" value={formatDate(Date.now() + (stats.nextDue - stats.today) * 86_400_000)} />}
          </div>
        </Section>
      )}

      <Sheet open={customOpen} onClose={() => setCustomOpen(false)} title="Учить ещё">
        <div className="stack">
          <div className="group">
            <div className="row">
              <span className="row__body">
                <span className="row__title">Новых карточек сверх лимита</span>
                <span className="row__sub">Только на сегодня</span>
              </span>
              <Stepper value={extra} onChange={setExtra} min={1} max={500} step={5} label="Дополнительно новых" />
            </div>
          </div>
          <button
            type="button"
            className="btn btn--block"
            disabled={stats.fresh === 0}
            onClick={() => {
              setCustomOpen(false)
              navigate(`/study/${deck.id}?extraNew=${extra}`)
            }}
          >
            Учить {count(extra, ['новую карточку', 'новые карточки', 'новых карточек'])}
          </button>
          {stats.fresh === 0 && <p className="section__foot">В колоде нет новых карточек.</p>}
          <div className="group">
            <ButtonRow
              onClick={() => {
                setCustomOpen(false)
                navigate(`/study/${deck.id}?ahead=1`)
              }}
              title="Повторить завтрашние заранее"
              sub="Карточки, срок которых наступит завтра. Алгоритм учтёт, что повторение было раньше срока."
              chevron
            />
          </div>
        </div>
      </Sheet>
    </Screen>
  )
}
