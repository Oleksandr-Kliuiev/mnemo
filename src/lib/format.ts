/** Russian plural forms: plural(5, ['карточка', 'карточки', 'карточек']) → 'карточек'. */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return forms[2]
  if (b > 1 && b < 5) return forms[1]
  if (b === 1) return forms[0]
  return forms[2]
}

export function count(n: number, forms: [string, string, string]): string {
  return `${formatNumber(n)} ${plural(n, forms)}`
}

export const CARDS: [string, string, string] = ['карточка', 'карточки', 'карточек']
export const NOTES: [string, string, string] = ['запись', 'записи', 'записей']
export const DAYS: [string, string, string] = ['день', 'дня', 'дней']
export const MINUTES: [string, string, string] = ['минута', 'минуты', 'минут']
export const REVIEWS: [string, string, string] = ['повторение', 'повторения', 'повторений']
export const DECKS: [string, string, string] = ['колода', 'колоды', 'колод']
export const FILES: [string, string, string] = ['файл', 'файла', 'файлов']

const nf = new Intl.NumberFormat('ru-RU')
export function formatNumber(n: number): string {
  return nf.format(n)
}

export function formatPercent(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits).replace('.', ',')} %`
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
const shortDateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })

export function formatDate(ms: number): string {
  return dateFmt.format(ms).replace(' г.', '')
}

export function formatShortDate(ms: number | Date): string {
  return shortDateFmt.format(ms).replace('.', '')
}

export function formatDateTime(ms: number): string {
  return `${formatDate(ms)}, ${timeFmt.format(ms)}`
}

export function formatTime(ms: number): string {
  return timeFmt.format(ms)
}

/** "5 мин", "1 ч 20 мин" — for study time. */
export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 1) return `${Math.max(0, Math.round(ms / 1000))} с`
  if (totalMin < 60) return `${totalMin} мин`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m ? `${h} ч ${m} мин` : `${h} ч`
}

/** Relative day phrase for due dates: "сегодня", "завтра", "через 5 дней", "3 дня назад". */
export function relativeDays(days: number): string {
  if (days === 0) return 'сегодня'
  if (days === 1) return 'завтра'
  if (days === -1) return 'вчера'
  if (days > 0) return `через ${count(days, DAYS)}`
  return `${count(-days, DAYS)} назад`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} ГБ`
}
