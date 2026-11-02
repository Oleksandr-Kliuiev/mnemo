import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { BarChart3 } from 'lucide-react'
import { Screen } from '../ui/Screen'
import { Sheet } from '../ui/Sheet'
import { DeckBadge, EmptyState, Loading, Segmented } from '../ui/controls'
import { ColumnChart, Heatmap, PartsBar } from '../ui/charts'
import { db } from '../db/db'
import { leafName } from '../db/repo'
import { loadStats, type RangeKey } from '../data/stats'
import { dayToDate } from '../sched/day'
import { DAYS, count, formatDuration, formatNumber, formatPercent, plural } from '../lib/format'
import { href } from '../lib/router'

const RANGES: { value: RangeKey; label: string }[] = [
  { value: 'month', label: 'Месяц' },
  { value: 'quarter', label: '3 месяца' },
  { value: 'year', label: 'Год' },
]

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

function dayTitle(day: number): string {
  const d = dayToDate(day)
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`
}

const BUTTONS: { label: string; color: string }[] = [
  { label: 'Снова', color: 'var(--again)' },
  { label: 'Трудно', color: 'var(--hard)' },
  { label: 'Хорошо', color: 'var(--good)' },
  { label: 'Легко', color: 'var(--easy)' },
]

function ButtonTiles({ counts }: { counts: [number, number, number, number] }) {
  const total = counts.reduce((a, b) => a + b, 0)
  return (
    <div className="tiles tiles--4">
      {BUTTONS.map((b, i) => {
        const share = total ? counts[i] / total : 0
        return (
          <div key={b.label} className="tile tile--flat">
            <span className="tile__label">{b.label}</span>
            <span className="tile__value">{total ? formatPercent(share) : '—'}</span>
            <span className="meter" aria-hidden>
              <span className="meter__fill" style={{ width: `${share * 100}%`, background: b.color }} />
            </span>
            <span className="tile__label">{formatNumber(counts[i])}</span>
          </div>
        )
      })}
    </div>
  )
}

export default function StatsScreen({ deckId }: { deckId?: number }) {
  const [range, setRange] = useState<RangeKey>('month')
  const [deck, setDeck] = useState<number | undefined>(deckId)
  const [pick, setPick] = useState(false)
  const decks = useLiveQuery(async () => (await db.decks.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'ru')), [])
  const data = useLiveQuery(() => loadStats(deck, range), [deck, range])
  const current = decks?.find((d) => d.id === deck)

  const rangeText = range === 'month' ? 'за 30 дней' : range === 'quarter' ? 'за 3 месяца' : 'за год'
  const ret = (p: [number, number]) => (p[1] ? formatPercent(p[0] / p[1]) : '—')
  const allRet: [number, number] = data ? [data.retention.young[0] + data.retention.mature[0], data.retention.young[1] + data.retention.mature[1]] : [0, 0]

  return (
    <Screen title="Статистика">
      <div className="stats-filters">
        <button type="button" className="chip" onClick={() => setPick(true)} aria-label={`Колода: ${current ? leafName(current.name) : 'все'}`}>
          {current ? leafName(current.name) : 'Все колоды'} ▾
        </button>
        <div className="stats-filters__range">
          <Segmented label="Период" value={range} options={RANGES} onChange={setRange} />
        </div>
      </div>

      {!data ? (
        <Loading />
      ) : data.totalReviews === 0 && data.states.fresh + data.states.learning + data.states.young + data.states.mature + data.states.suspended === 0 ? (
        <EmptyState icon={<BarChart3 size={40} />} title="Пока нет данных" text="Статистика появится после первых занятий.">
          <a className="btn" href={href('/')}>
            К колодам
          </a>
        </EmptyState>
      ) : (
        <>
          <div className="tiles stats-tiles">
            <div className="tile">
              <span className="tile__label">Сегодня</span>
              <span className="tile__value">{formatNumber(data.reviewsToday)}</span>
              <span className="tile__label">{data.reviewsToday ? formatDuration(data.timeTodayMs) : 'ответов'}</span>
            </div>
            <div className="tile">
              <span className="tile__label">Серия</span>
              <span className="tile__value">{data.streak}</span>
              <span className="tile__label">{plural(data.streak, DAYS)} подряд</span>
            </div>
            <div className="tile">
              <span className="tile__label">Вспомнили</span>
              <span className="tile__value">{ret(allRet)}</span>
              <span className="tile__label">повторений {rangeText}</span>
            </div>
          </div>

          <section className="stat-card" aria-labelledby="st-heat">
            <div className="stat-card__head">
              <h2 className="stat-card__title" id="st-heat">
                Активность
              </h2>
              <span className="stat-card__note">
                {count(data.activeDays, DAYS)} с занятиями {rangeText}
              </span>
            </div>
            <Heatmap data={data.heat} today={data.today} max={data.heatMax} dayTitle={dayTitle} />
          </section>

          <section className="stat-card" aria-labelledby="st-fc">
            <div className="stat-card__head">
              <h2 className="stat-card__title" id="st-fc">
                Прогноз повторений
              </h2>
              <span className="stat-card__note">{formatNumber(data.forecast.reduce((a, b) => a + b, 0))} карточек</span>
            </div>
            <ColumnChart
              ariaLabel="Прогноз повторений"
              labels={data.forecastBuckets.map((b) => b.label)}
              titles={data.forecastBuckets.map((b) => b.title)}
              series={[{ key: 'due', label: 'к повторению', color: 'var(--viz-1)', values: data.forecast }]}
              highlight={0}
              emptyText="Повторений не запланировано"
            />
            <p className="stat-card__foot">Первый столбец — сегодня, вместе с просроченными.</p>
          </section>

          <section className="stat-card" aria-labelledby="st-hist">
            <div className="stat-card__head">
              <h2 className="stat-card__title" id="st-hist">
                Ответы
              </h2>
              <span className="stat-card__note">
                {formatNumber(data.totalReviews)} · {formatDuration(data.totalTimeMs)}
              </span>
            </div>
            <ColumnChart
              ariaLabel="Ответы по дням"
              labels={data.buckets.map((b) => b.label)}
              titles={data.buckets.map((b) => b.title)}
              series={[
                { key: 'fresh', label: 'Новые', color: 'var(--viz-1)', values: data.history.map((h) => h.fresh) },
                { key: 'learn', label: 'Изучение', color: 'var(--viz-2)', values: data.history.map((h) => h.learn) },
                { key: 'review', label: 'Повторение', color: 'var(--viz-3)', values: data.history.map((h) => h.review) },
              ]}
              highlight={data.buckets.length - 1}
              emptyText="Ответов за этот период нет"
            />
          </section>

          <section className="stat-card" aria-labelledby="st-ret">
            <div className="stat-card__head">
              <h2 className="stat-card__title" id="st-ret">
                Удержание
              </h2>
              <span className="stat-card__note">{rangeText}</span>
            </div>
            <div className="tiles tiles--2">
              <div className="tile tile--flat">
                <span className="tile__value">{ret(data.retention.young)}</span>
                <span className="tile__label">молодые карточки · {formatNumber(data.retention.young[1])}</span>
              </div>
              <div className="tile tile--flat">
                <span className="tile__value">{ret(data.retention.mature)}</span>
                <span className="tile__label">зрелые (от 21 дня) · {formatNumber(data.retention.mature[1])}</span>
              </div>
            </div>
            <p className="stat-card__foot">Доля повторений, где вы вспомнили ответ (всё, кроме «Снова»). Ориентир — желаемое удержание в настройках.</p>
          </section>

          <section className="stat-card" aria-labelledby="st-btn">
            <div className="stat-card__head">
              <h2 className="stat-card__title" id="st-btn">
                Кнопки при повторении
              </h2>
            </div>
            <ButtonTiles counts={data.buttons} />
          </section>

          <section className="stat-card" aria-labelledby="st-states">
            <div className="stat-card__head">
              <h2 className="stat-card__title" id="st-states">
                Карточки
              </h2>
              <span className="stat-card__note">
                {formatNumber(data.states.fresh + data.states.learning + data.states.young + data.states.mature + data.states.suspended)} всего
              </span>
            </div>
            <PartsBar
              ariaLabel="Состояние карточек"
              parts={[
                { label: 'Новые', value: data.states.fresh, color: 'var(--viz-1)' },
                { label: 'В изучении', value: data.states.learning, color: 'var(--viz-2)' },
                { label: 'Молодые', value: data.states.young, color: 'var(--viz-3)' },
                { label: 'Зрелые', value: data.states.mature, color: 'var(--viz-4)' },
                { label: 'Приостановлены', value: data.states.suspended, color: 'var(--viz-5)' },
              ]}
            />
          </section>
        </>
      )}

      <Sheet open={pick} onClose={() => setPick(false)} title="Колода">
        <div className="group">
          <button
            type="button"
            className="row"
            aria-pressed={deck == null}
            onClick={() => {
              setDeck(undefined)
              setPick(false)
            }}
          >
            <span className={`check${deck == null ? ' check--on' : ''}`} aria-hidden>
              ✓
            </span>
            <span className="row__body">Все колоды</span>
          </button>
          {decks?.map((d) => (
            <button
              key={d.id}
              type="button"
              className="row"
              style={{ paddingLeft: `calc(var(--s-4) + ${(d.name.split('::').length - 1) * 20}px)` }}
              aria-pressed={deck === d.id}
              onClick={() => {
                setDeck(d.id)
                setPick(false)
              }}
            >
              <span className={`check${deck === d.id ? ' check--on' : ''}`} aria-hidden>
                ✓
              </span>
              <DeckBadge color={d.color} emoji={d.emoji} name={leafName(d.name)} size="small" />
              <span className="row__body">{leafName(d.name)}</span>
            </button>
          ))}
        </div>
      </Sheet>
    </Screen>
  )
}
