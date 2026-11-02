import { escapeHtml, plainText } from './html'

/** Cloze deletions: {{c1::answer}} or {{c1::answer::hint}}, nesting supported. */
export type ClozeNode = { t: 'text'; v: string } | { t: 'cloze'; n: number; kids: ClozeNode[]; hint: string | null }

interface Frame {
  n: number
  kids: ClozeNode[]
  hint: string | null
  inHint: boolean
  open: string
}

const OPEN_RE = /^\{\{c(\d+)::/

export function parseCloze(text: string): ClozeNode[] {
  const root: ClozeNode[] = []
  const stack: Frame[] = []
  let buf = ''
  const target = () => (stack.length ? stack[stack.length - 1].kids : root)
  const flush = () => {
    if (!buf) return
    const top = stack[stack.length - 1]
    if (top?.inHint) top.hint = (top.hint ?? '') + buf
    else target().push({ t: 'text', v: buf })
    buf = ''
  }
  let i = 0
  while (i < text.length) {
    if (text.startsWith('{{c', i)) {
      const m = OPEN_RE.exec(text.slice(i, i + 16))
      if (m && !stack[stack.length - 1]?.inHint) {
        flush()
        stack.push({ n: Number(m[1]), kids: [], hint: null, inHint: false, open: m[0] })
        i += m[0].length
        continue
      }
    }
    if (stack.length && text.startsWith('}}', i)) {
      flush()
      const f = stack.pop()!
      target().push({ t: 'cloze', n: f.n, kids: f.kids, hint: f.hint })
      i += 2
      continue
    }
    if (stack.length && !stack[stack.length - 1].inHint && text.startsWith('::', i)) {
      flush()
      stack[stack.length - 1].inHint = true
      stack[stack.length - 1].hint = ''
      i += 2
      continue
    }
    buf += text[i]
    i++
  }
  flush()
  // Unclosed deletions are kept as literal text.
  while (stack.length) {
    const f = stack.pop()!
    const literal: ClozeNode[] = [{ t: 'text', v: f.open }, ...f.kids]
    if (f.hint != null) literal.push({ t: 'text', v: '::' + f.hint })
    target().push(...literal)
  }
  return root
}

export function clozeNumbers(text: string): number[] {
  const set = new Set<number>()
  const walk = (nodes: ClozeNode[]) => {
    for (const n of nodes) {
      if (n.t === 'cloze') {
        set.add(n.n)
        walk(n.kids)
      }
    }
  }
  walk(parseCloze(text))
  return [...set].filter((n) => n > 0).sort((a, b) => a - b)
}

function render(nodes: ClozeNode[], n: number, side: 'q' | 'a'): string {
  let out = ''
  for (const node of nodes) {
    if (node.t === 'text') {
      out += node.v
    } else if (node.n === n) {
      const inner = render(node.kids, n, 'a')
      if (side === 'q') {
        const shown = node.hint ? `[${node.hint}]` : '[...]'
        out += `<span class="cloze" data-cloze="${escapeHtml(inner)}" data-ordinal="${n}">${shown}</span>`
      } else {
        out += `<span class="cloze" data-ordinal="${n}">${inner}</span>`
      }
    } else {
      out += `<span class="cloze-inactive" data-ordinal="${node.n}">${render(node.kids, n, side)}</span>`
    }
  }
  return out
}

export function renderCloze(text: string, n: number, side: 'q' | 'a'): string {
  return render(parseCloze(text), n, side)
}

/** Text of the active deletions only (for {{cloze-only:}} and typing the answer). */
export function clozeOnly(text: string, n: number): string {
  const parts: string[] = []
  const walk = (nodes: ClozeNode[]) => {
    for (const node of nodes) {
      if (node.t !== 'cloze') continue
      if (node.n === n) parts.push(render(node.kids, n, 'a'))
      else walk(node.kids)
    }
  }
  walk(parseCloze(text))
  return parts.join(', ')
}

export function clozeOnlyText(text: string, n: number): string {
  return plainText(clozeOnly(text, n))
}
