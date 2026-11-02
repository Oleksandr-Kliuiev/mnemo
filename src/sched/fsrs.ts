import {
  computeDecayFactor,
  default_w,
  fsrs,
  forgetting_curve,
  type Card as FCard,
  type FSRS,
  type StepUnit,
} from 'ts-fsrs'
import { CardState, type Card, type Grade, type ReviewEntry, type Settings } from '../db/types'
import { dayIndex, fromStudyFrame, toStudyFrame, DAY_MS } from './day'

export interface SchedConfig {
  retention: number
  maxInterval: number
  learningSteps: StepUnit[]
  relearningSteps: StepUnit[]
  weights: readonly number[]
  cutoff: number
  fuzz: boolean
}

const STEP_RE = /^(\d+(?:\.\d+)?)([mhd]?)$/i

/** Parse "1m 10m", "1 10", "30m 1h 1d". Bare numbers are minutes. Returns null when invalid. */
export function parseSteps(text: string): StepUnit[] | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean)
  const out: StepUnit[] = []
  for (const p of parts) {
    const m = STEP_RE.exec(p)
    if (!m) return null
    const n = Number(m[1])
    if (!(n > 0)) return null
    out.push(`${n}${(m[2] || 'm').toLowerCase()}` as StepUnit)
  }
  return out
}

/** Parse a comma/space separated list of FSRS weights (17, 19 or 21 numbers). */
export function parseWeights(text: string): number[] | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean)
  if (parts.length === 0) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return null
  if (![17, 19, 21].includes(nums.length)) return null
  return nums
}

export function schedConfig(settings: Settings, deckRetention?: number | null): SchedConfig {
  return {
    retention: clamp(deckRetention ?? settings.desiredRetention, 0.7, 0.99),
    maxInterval: Math.max(1, Math.round(settings.maxInterval)),
    learningSteps: parseSteps(settings.learningSteps) ?? ['1m', '10m'],
    relearningSteps: parseSteps(settings.relearningSteps) ?? ['10m'],
    weights: parseWeights(settings.weights) ?? default_w,
    cutoff: settings.dayCutoff,
    fuzz: true,
  }
}

const cache = new Map<string, FSRS>()

function scheduler(cfg: SchedConfig): FSRS {
  const key = JSON.stringify([cfg.retention, cfg.maxInterval, cfg.learningSteps, cfg.relearningSteps, cfg.weights, cfg.fuzz])
  let f = cache.get(key)
  if (!f) {
    f = fsrs({
      request_retention: cfg.retention,
      maximum_interval: cfg.maxInterval,
      w: [...cfg.weights],
      enable_fuzz: cfg.fuzz,
      enable_short_term: true,
      learning_steps: cfg.learningSteps,
      relearning_steps: cfg.relearningSteps,
    })
    cache.set(key, f)
  }
  return f
}

function toF(card: Card, cutoff: number): FCard {
  return {
    due: new Date(toStudyFrame(card.due, cutoff)),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: 0,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.lastReview != null ? new Date(toStudyFrame(card.lastReview, cutoff)) : undefined,
  }
}

function fromF(base: Card, fc: FCard, now: number, cutoff: number): Card {
  return {
    ...base,
    state: fc.state as CardState,
    due: fromStudyFrame(fc.due.getTime(), cutoff),
    stability: fc.stability,
    difficulty: fc.difficulty,
    scheduledDays: fc.scheduled_days,
    learningSteps: fc.learning_steps,
    reps: fc.reps,
    lapses: fc.lapses,
    lastReview: now,
    modifiedAt: now,
  }
}

export interface AnswerOutcome {
  grade: Grade
  card: Card
  /** Time until the card is shown again. */
  intervalMs: number
  label: string
  entry: Omit<ReviewEntry, 'id' | 'durationMs'>
}

export type AnswerPreview = Record<Grade, AnswerOutcome>

const GRADES: Grade[] = [1, 2, 3, 4]

export function previewAnswers(card: Card, now: number, cfg: SchedConfig): AnswerPreview {
  const f = scheduler(cfg)
  const fnow = new Date(toStudyFrame(now, cfg.cutoff))
  const preview = f.repeat(toF(card, cfg.cutoff), fnow)
  const today = dayIndex(now, cfg.cutoff)
  const elapsedDays = card.lastReview != null ? Math.max(0, today - dayIndex(card.lastReview, cfg.cutoff)) : 0
  const out = {} as AnswerPreview
  for (const g of GRADES) {
    const item = preview[g]
    const next = fromF(card, item.card, now, cfg.cutoff)
    const intervalMs = Math.max(0, next.due - now)
    out[g] = {
      grade: g,
      card: next,
      intervalMs,
      label: next.scheduledDays >= 1 && next.state === CardState.Review ? formatDays(next.scheduledDays) : formatInterval(intervalMs),
      entry: {
        cardId: card.id,
        deckId: card.deckId,
        time: now,
        day: today,
        rating: g,
        state: card.state,
        stability: next.stability,
        difficulty: next.difficulty,
        scheduledDays: next.scheduledDays,
        elapsedDays,
      },
    }
  }
  return out
}

/**
 * Re-time a previewed outcome to the moment the user actually answered,
 * so the interval shown on the button is the interval the card gets.
 */
export function finalizeOutcome(o: AnswerOutcome, answeredAt: number, cfg: SchedConfig): AnswerOutcome {
  const delta = answeredAt - o.entry.time
  return {
    ...o,
    card: { ...o.card, due: o.card.due + delta, lastReview: answeredAt, modifiedAt: answeredAt },
    entry: { ...o.entry, time: answeredAt, day: dayIndex(answeredAt, cfg.cutoff) },
  }
}

/** Probability of recall right now (0..1), or null for new cards. */
export function retrievability(card: Card, now: number, cfg: SchedConfig): number | null {
  if (card.state === CardState.New || card.lastReview == null || card.stability <= 0) return null
  const elapsed = Math.max(0, (now - card.lastReview) / DAY_MS)
  return forgetting_curve([...cfg.weights], elapsed, card.stability)
}

/** Reset a card to new, keeping its review history. */
export function forgetCard(card: Card, now: number, position: number): Card {
  return {
    ...card,
    state: CardState.New,
    due: position,
    stability: 0,
    difficulty: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    lastReview: null,
    modifiedAt: now,
  }
}

/**
 * Estimate an FSRS memory state from SM-2 data (ease factor and interval),
 * the same approach fsrs-rs uses when FSRS is enabled on an existing collection.
 */
export function memoryFromSm2(
  easeFactor: number,
  intervalDays: number,
  retention = 0.9,
  w: readonly number[] = default_w,
): { stability: number; difficulty: number } {
  const { decay, factor } = computeDecayFactor([...w])
  const stability = (Math.max(intervalDays, 0.1) * factor) / (Math.pow(retention, 1 / decay) - 1)
  const denom = Math.exp(w[8]) * Math.pow(stability, -w[9]) * Math.expm1((1 - retention) * w[10])
  const difficulty = 11 - (Math.max(easeFactor, 1.3) - 1) / denom
  return { stability: clamp(stability, 0.01, 36500), difficulty: clamp(difficulty, 1, 10) }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function trimNum(n: number): string {
  const r = n < 10 ? Math.round(n * 10) / 10 : Math.round(n)
  return String(r).replace('.', ',')
}

export function formatDays(days: number): string {
  if (days < 30) return `${Math.round(days)} д`
  if (days < 365) return `${trimNum(days / 30.44)} мес`
  return `${trimNum(days / 365.25)} г`
}

export function formatInterval(ms: number): string {
  const min = ms / 60_000
  if (min < 1) return '<1 мин'
  if (min < 60) return `${Math.round(min)} мин`
  const h = min / 60
  if (h < 24) return `${trimNum(h)} ч`
  return formatDays(h / 24)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
