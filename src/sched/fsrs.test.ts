import { describe, expect, it } from 'vitest'
import { formatInterval, memoryFromSm2, parseSteps, parseWeights, previewAnswers, schedConfig } from './fsrs'
import { DEFAULT_SETTINGS } from '../db/settings'
import { newCard } from '../db/repo'
import { dayIndex, dayStart, fromStudyFrame, toStudyFrame } from './day'
import type { Card } from '../db/types'

const cfg = { ...schedConfig(DEFAULT_SETTINGS), fuzz: false }
const now = new Date(2026, 9, 20, 15, 0).getTime()

describe('fsrs wrapper', () => {
  it('uses learning steps for new cards', () => {
    const card = { ...newCard(1, 1, 0, now, now), id: 1 } as Card
    const p = previewAnswers(card, now, cfg)
    expect(p[1].label).toBe('1 мин')
    expect(p[3].label).toBe('10 мин')
    expect(p[4].card.state).toBe(2)
    expect(p[4].card.scheduledDays).toBeGreaterThanOrEqual(1)
  })
  it('graduates after the last step and schedules by days', () => {
    let card = { ...newCard(1, 1, 0, now, now), id: 1 } as Card
    card = previewAnswers(card, now, cfg)[3].card
    const t2 = card.due
    card = previewAnswers(card, t2, cfg)[3].card
    expect(card.state).toBe(2)
    expect(card.scheduledDays).toBeGreaterThanOrEqual(1)
    const p = previewAnswers(card, card.due, cfg)
    expect(p[3].card.scheduledDays).toBeGreaterThan(card.scheduledDays)
    expect(p[1].card.state).toBe(3)
  })
  it('parses steps and weights', () => {
    expect(parseSteps('1m 10m')).toEqual(['1m', '10m'])
    expect(parseSteps('1 10 1h 2d')).toEqual(['1m', '10m', '1h', '2d'])
    expect(parseSteps('x')).toBeNull()
    expect(parseWeights('1,2')).toBeNull()
  })
  it('formats intervals in Russian', () => {
    expect(formatInterval(30_000)).toBe('<1 мин')
    expect(formatInterval(10 * 60_000)).toBe('10 мин')
    expect(formatInterval(3 * 3_600_000)).toBe('3 ч')
    expect(formatInterval(45 * 86_400_000)).toBe('1,5 мес')
  })
  it('converts SM-2 state to a plausible FSRS memory state', () => {
    const easy = memoryFromSm2(3.0, 30)
    const hard = memoryFromSm2(1.3, 30)
    expect(easy.stability).toBeCloseTo(30, 0)
    expect(easy.difficulty).toBeLessThan(hard.difficulty)
    expect(hard.difficulty).toBeLessThanOrEqual(10)
  })
})

describe('study days', () => {
  it('starts the day at the cutoff hour', () => {
    const late = new Date(2026, 9, 20, 2, 0).getTime()
    const morning = new Date(2026, 9, 20, 5, 0).getTime()
    expect(dayIndex(morning, 4) - dayIndex(late, 4)).toBe(1)
    expect(dayStart(dayIndex(morning, 4), 4)).toBe(new Date(2026, 9, 20, 4, 0).getTime())
  })
  it('round-trips the study frame', () => {
    expect(fromStudyFrame(toStudyFrame(now, 4), 4)).toBe(now)
  })
})
