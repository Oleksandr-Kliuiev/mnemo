import { CardState, type Card, type Note } from '../db/types'
import { dayIndex, DAY_MS } from '../sched/day'

export interface SearchCtx {
  card: Card
  note: Note
  deckName: string
  today: number
  now: number
  cutoff: number
}

type Pred = (c: SearchCtx) => boolean

function tokenize(q: string): string[] {
  const out: string[] = []
  const re = /(-?)(\w+:)?"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(q))) {
    if (m[4] !== undefined) out.push(m[4])
    else out.push(`${m[1]}${m[2] ?? ''}${m[3]}`)
  }
  return out
}

function wildcard(pattern: string): RegExp {
  const esc = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/_/g, '.')
  return new RegExp(`^${esc}$`)
}

function isDue(c: SearchCtx): boolean {
  const { card } = c
  if (card.suspended || card.state === CardState.New) return false
  if (card.state === CardState.Review) return dayIndex(card.due, c.cutoff) <= c.today
  return card.due <= c.now || dayIndex(card.due, c.cutoff) <= c.today
}

function term(tok: string): Pred {
  const lower = tok.toLowerCase()
  const i = lower.indexOf(':')
  if (i > 0) {
    const key = lower.slice(0, i)
    const val = tok.slice(i + 1)
    const v = val.toLowerCase()
    switch (key) {
      case 'deck': {
        const re = wildcard(v.replace(/\s*::\s*/g, '::'))
        const reSub = wildcard(v.replace(/\s*::\s*/g, '::') + '::*')
        return (c) => {
          const n = c.deckName.toLowerCase()
          return re.test(n) || reSub.test(n)
        }
      }
      case 'tag': {
        if (v === 'none') return (c) => c.note.tags.length === 0
        const re = wildcard(v)
        return (c) => c.note.tags.some((t) => re.test(t.toLowerCase()))
      }
      case 'is':
        switch (v) {
          case 'new':
            return (c) => c.card.state === CardState.New
          case 'learn':
            return (c) => c.card.state === CardState.Learning || c.card.state === CardState.Relearning
          case 'review':
            return (c) => c.card.state === CardState.Review
          case 'due':
            return isDue
          case 'suspended':
            return (c) => c.card.suspended === 1
          case 'buried':
            return (c) => c.card.buriedDay === c.today
          case 'leech':
            return (c) => c.note.tags.includes('leech')
        }
        return () => false
      case 'flag': {
        const n = Number(v)
        return (c) => c.card.flag === n
      }
      case 'added': {
        const days = Number(v)
        return (c) => c.card.createdAt >= c.now - days * DAY_MS
      }
      case 'card': {
        const n = Number(v)
        return (c) => c.card.ord + 1 === n
      }
    }
  }
  return (c) => c.note.searchText.includes(lower)
}

/** Anki-like search: words (AND), "phrases", -negation, deck:, tag:, is:, flag:, added:, card:. */
export function compileSearch(query: string): Pred {
  const preds = tokenize(query.trim()).map((tok) => {
    if (tok.startsWith('-') && tok.length > 1) {
      const p = term(tok.slice(1))
      return (c: SearchCtx) => !p(c)
    }
    return term(tok)
  })
  return (c) => preds.every((p) => p(c))
}

export const SEARCH_HELP: [string, string][] = [
  ['кошка собака', 'обе слова в записи'],
  ['"доброе утро"', 'точная фраза'],
  ['-кошка', 'без слова «кошка»'],
  ['deck:Английский', 'колода и её подколоды'],
  ['tag:глаголы', 'с меткой (можно tag:глаг*)'],
  ['is:due', 'к повторению сегодня'],
  ['is:new · is:learn · is:review', 'по состоянию'],
  ['is:suspended · is:leech', 'приостановленные · часто забываемые'],
  ['flag:1', 'с красным флагом (1–7)'],
  ['added:7', 'добавлены за 7 дней'],
]
