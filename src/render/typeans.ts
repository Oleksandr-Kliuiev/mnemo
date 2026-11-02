import { escapeHtml } from './html'

type Op = { kind: 'same' | 'typed' | 'missed'; text: string }

function normalize(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** Character diff via LCS. Strings on cards are short, O(n·m) is fine. */
function diff(a: string, b: string): Op[] {
  const A = [...a]
  const B = [...b]
  if (A.length * B.length > 250_000) {
    return [
      { kind: 'typed', text: a },
      { kind: 'missed', text: b },
    ]
  }
  const n = A.length
  const m = B.length
  const L: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }
  const ops: Op[] = []
  const push = (kind: Op['kind'], ch: string) => {
    const last = ops[ops.length - 1]
    if (last && last.kind === kind) last.text += ch
    else ops.push({ kind, text: ch })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', A[i])
      i++
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      push('typed', A[i++])
    } else {
      push('missed', B[j++])
    }
  }
  while (i < n) push('typed', A[i++])
  while (j < m) push('missed', B[j++])
  return ops
}

/** Anki-style comparison of the typed answer with the expected one. */
export function compareTypeAnswer(typedRaw: string, expectedRaw: string): string {
  const typed = normalize(typedRaw)
  const expected = normalize(expectedRaw)
  const e = escapeHtml
  if (!typed) {
    return `<div class="typeans"><span class="typeMissed">${e(expected)}</span></div>`
  }
  if (typed === expected) {
    return `<div class="typeans"><span class="typeGood">${e(expected)}</span></div>`
  }
  const ops = diff(typed, expected)
  const typedHtml = ops
    .filter((o) => o.kind !== 'missed')
    .map((o) => `<span class="${o.kind === 'same' ? 'typeGood' : 'typeBad'}">${e(o.text)}</span>`)
    .join('')
  const expectedHtml = ops
    .filter((o) => o.kind !== 'typed')
    .map((o) => `<span class="${o.kind === 'same' ? 'typeGood' : 'typeMissed'}">${e(o.text)}</span>`)
    .join('')
  return `<div class="typeans">${typedHtml}<br><span class="typearrow">↓</span><br>${expectedHtml}</div>`
}

export function typedAnswerIsCorrect(typed: string, expected: string): boolean {
  return normalize(typed) === normalize(expected)
}
