import { useEffect, useState } from 'react'

/** Minimal hash router ("#/deck/12?x=1"); hash routing works on any static host. */
export interface Route {
  path: string
  parts: string[]
  query: URLSearchParams
}

function rawHash(): string {
  return location.hash.replace(/^#/, '') || '/'
}

function parse(raw = rawHash()): Route {
  const [path, qs = ''] = raw.split('?')
  const clean = path.startsWith('/') ? path : '/' + path
  return { path: clean, parts: clean.split('/').filter(Boolean), query: new URLSearchParams(qs) }
}

type Listener = (r: Route) => void
const listeners = new Set<Listener>()
let currentRaw = rawHash()
let current = parse(currentRaw)

// Position inside the app's own history, so "back" never leaves the app.
let idx = typeof history.state?.idx === 'number' ? (history.state.idx as number) : 0
if (typeof history.state?.idx !== 'number') history.replaceState({ ...(history.state ?? {}), idx }, '')

function withTransition(fn: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (doc.startViewTransition && !reduce && document.visibilityState === 'visible') {
    try {
      doc.startViewTransition(fn)
      return
    } catch {
      /* fall through */
    }
  }
  fn()
}

function emit() {
  const raw = rawHash()
  if (raw === currentRaw) return
  currentRaw = raw
  current = parse(raw)
  withTransition(() => {
    for (const l of listeners) l(current)
  })
}

window.addEventListener('popstate', (e) => {
  idx = typeof e.state?.idx === 'number' ? e.state.idx : 0
  emit()
})
window.addEventListener('hashchange', emit)

export function useRoute(): Route {
  const [r, setR] = useState(current)
  useEffect(() => {
    listeners.add(setR)
    setR(current)
    return () => {
      listeners.delete(setR)
    }
  }, [])
  return r
}

export function href(to: string): string {
  return '#' + (to.startsWith('/') ? to : '/' + to)
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const hash = href(to)
  if (opts.replace) {
    history.replaceState({ idx }, '', hash)
  } else {
    if (location.hash === hash) return
    idx++
    history.pushState({ idx }, '', hash)
  }
  emit()
  window.scrollTo(0, 0)
}

/** Back inside the app when possible, otherwise replace with the fallback route. */
export function goBack(fallback = '/'): void {
  if (idx > 0) history.back()
  else navigate(fallback, { replace: true })
}

export function canGoBack(): boolean {
  return idx > 0
}
