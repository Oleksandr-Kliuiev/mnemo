/**
 * Study days. Like Anki, a "day" starts at a configurable hour (default 04:00 local time),
 * so a late-night session still counts towards the previous day.
 * A day is identified by an integer: days since 1970-01-01 of the local calendar date.
 */

const DAY_MS = 86_400_000

export function dayIndex(ms: number, cutoffHour: number): number {
  const d = new Date(ms - cutoffHour * 3_600_000)
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS)
}

/** Epoch ms at which the given study day starts. */
export function dayStart(day: number, cutoffHour: number): number {
  const d = new Date(day * DAY_MS)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), cutoffHour).getTime()
}

/** Calendar date (local midnight) of a study day, for display. */
export function dayToDate(day: number): Date {
  const d = new Date(day * DAY_MS)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/**
 * Shift a real timestamp into a frame where UTC calendar days equal local study days.
 * ts-fsrs counts elapsed days by UTC date, so we feed it shifted times.
 */
export function toStudyFrame(ms: number, cutoffHour: number): number {
  const offset = -new Date(ms).getTimezoneOffset() * 60_000
  return ms + offset - cutoffHour * 3_600_000
}

export function fromStudyFrame(ms: number, cutoffHour: number): number {
  let guess = ms + cutoffHour * 3_600_000
  // Two iterations settle the offset even across a DST change.
  for (let i = 0; i < 2; i++) {
    const offset = -new Date(guess).getTimezoneOffset() * 60_000
    guess = ms - offset + cutoffHour * 3_600_000
  }
  return guess
}

export { DAY_MS }
