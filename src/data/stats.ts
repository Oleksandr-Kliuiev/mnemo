import { db } from '../db/db'
import { getSettings } from '../db/settings'
import { CardState, type Card, type ReviewEntry } from '../db/types'
import { isInSubtree } from '../db/repo'
import { dayIndex, dayToDate } from '../sched/day'
import { computeStreak } from './overview'

export type RangeKey = 'month' | 'quarter' | 'year'
export const RANGE_DAYS: Record<RangeKey, number> = { month: 30, quarter: 91, year: 365 }

export interface Bucket {
  /** First study day of the bucket. */
  start: number
  /** Number of days in the bucket. */
  days: number
  label: string
  /** Long label for tooltips and tables. */
  title: string
}

export interface StatsData {
  today: number
  reviewsToday: number
  timeTodayMs: number
  streak: number
  heat: Map<number, number>
  heatMax: number
  buckets: Bucket[]
  forecastBuckets: Bucket[]
  forecast: number[]
  history: { fresh: number; learn: number; review: number }[]
  retention: { young: [number, number]; mature: [number, number] }
  states: { fresh: number; learning: number; young: number; mature: number; suspended: number }
  buttons: [number, number, number, number]
  totalReviews: number
  totalTimeMs: number
  activeDays: number
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const MONTHS_LONG = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

function dayLabel(day: number): { label: string; title: string } {
  const d = dayToDate(day)
  return {
    label: String(d.getDate()),
    title: `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`,
  }
}

/** Buckets covering `days` days ending at `endDay` (past) or starting at `startDay` (future). */
export function makeBuckets(range: RangeKey, from: number, direction: 'past' | 'future'): Bucket[] {
  const total = RANGE_DAYS[range]
  const size = range === 'month' ? 1 : range === 'quarter' ? 7 : 0
  const out: Bucket[] = []
  if (size > 0) {
    const n = Math.ceil(total / size)
    for (let i = 0; i < n; i++) {
      const start = direction === 'past' ? from - (n - 1 - i) * size - (size - 1) : from + i * size
      const { label, title } = dayLabel(start)
      out.push({
        start,
        days: size,
        label: size === 1 ? label : title,
        title: size === 1 ? title : `${title} – ${dayLabel(start + size - 1).title}`,
      })
    }
    return out
  }
  // Months.
  const base = dayToDate(from)
  for (let i = 0; i < 12; i++) {
    const offset = direction === 'past' ? i - 11 : i
    const m = new Date(base.getFullYear(), base.getMonth() + offset, 1)
    const next = new Date(m.getFullYear(), m.getMonth() + 1, 1)
    const start = Math.round(Date.UTC(m.getFullYear(), m.getMonth(), m.getDate()) / 86_400_000)
    const end = Math.round(Date.UTC(next.getFullYear(), next.getMonth(), next.getDate()) / 86_400_000)
    out.push({ start, days: end - start, label: MONTHS_SHORT[m.getMonth()], title: `${MONTHS_LONG[m.getMonth()]} ${m.getFullYear()}` })
  }
  return out
}

function bucketIndex(buckets: Bucket[], day: number): number {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]
    if (day >= b.start && day < b.start + b.days) return i
  }
  return -1
}

export async function loadStats(deckId: number | undefined, range: RangeKey, now = Date.now()): Promise<StatsData> {
  const settings = await getSettings()
  const cutoff = settings.dayCutoff
  const today = dayIndex(now, cutoff)
  let deckIds: Set<number> | null = null
  if (deckId != null) {
    const root = await db.decks.get(deckId)
    const all = await db.decks.toArray()
    deckIds = new Set(root ? all.filter((d) => isInSubtree(d.name, root.name)).map((d) => d.id) : [])
  }
  const inScope = (id: number) => deckIds == null || deckIds.has(id)

  const cards: Card[] = deckIds ? await db.cards.where('deckId').anyOf([...deckIds]).toArray() : await db.cards.toArray()
  const since = today - 371
  const revs: ReviewEntry[] = (await db.revlog.where('day').aboveOrEqual(since).toArray()).filter((r) => inScope(r.deckId))

  const heat = new Map<number, number>()
  for (const r of revs) heat.set(r.day, (heat.get(r.day) ?? 0) + 1)
  const heatMax = Math.max(0, ...heat.values())

  const buckets = makeBuckets(range, today, 'past')
  const history = buckets.map(() => ({ fresh: 0, learn: 0, review: 0 }))
  const rangeStart = buckets[0]?.start ?? today
  let totalReviews = 0
  let totalTimeMs = 0
  const activeSet = new Set<number>()
  const buttons: [number, number, number, number] = [0, 0, 0, 0]
  const young: [number, number] = [0, 0]
  const mature: [number, number] = [0, 0]
  for (const r of revs) {
    if (r.day < rangeStart || r.day > today) continue
    const i = bucketIndex(buckets, r.day)
    if (i >= 0) {
      if (r.state === CardState.New) history[i].fresh++
      else if (r.state === CardState.Review) history[i].review++
      else history[i].learn++
    }
    totalReviews++
    totalTimeMs += r.durationMs
    activeSet.add(r.day)
    if (r.state === CardState.Review) {
      buttons[r.rating - 1]++
      const bucket = r.elapsedDays >= 21 ? mature : young
      bucket[1]++
      if (r.rating > 1) bucket[0]++
    }
  }

  const forecastBuckets = makeBuckets(range, today, 'future')
  const forecast = forecastBuckets.map(() => 0)
  const states = { fresh: 0, learning: 0, young: 0, mature: 0, suspended: 0 }
  for (const c of cards) {
    if (c.suspended) {
      states.suspended++
      continue
    }
    if (c.state === CardState.New) {
      states.fresh++
      continue
    }
    if (c.state === CardState.Review) {
      if (c.scheduledDays >= 21) states.mature++
      else states.young++
    } else states.learning++
    const d = Math.max(today, dayIndex(c.due, cutoff))
    const i = bucketIndex(forecastBuckets, d)
    if (i >= 0) forecast[i]++
  }

  const todayRevs = revs.filter((r) => r.day === today)
  let streak: number
  if (deckIds == null) {
    streak = (await computeStreak(today)).streak
  } else {
    // Streak within the chosen deck.
    let d = heat.has(today) ? today : today - 1
    streak = 0
    while (heat.has(d)) {
      streak++
      d--
    }
  }

  return {
    today,
    reviewsToday: todayRevs.length,
    timeTodayMs: todayRevs.reduce((s, r) => s + r.durationMs, 0),
    streak,
    heat,
    heatMax,
    buckets,
    forecastBuckets,
    forecast,
    history,
    retention: { young, mature },
    states,
    buttons,
    totalReviews,
    totalTimeMs,
    activeDays: activeSet.size,
  }
}
