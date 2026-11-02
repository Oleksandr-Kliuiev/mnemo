import { useLayoutEffect, useRef } from 'react'
import { isExternalSrc, mediaUrl, safeDecode } from '../db/media'
import { playSounds } from '../lib/audio'
import { speak } from '../lib/tts'

const SPEAKER_SVG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M11 5 6 9H2v6h4l5 4V5z'/%3E%3Cpath d='M15.5 8.5a5 5 0 0 1 0 7'/%3E%3Cpath d='M19 5a10 10 0 0 1 0 14'/%3E%3C/svg%3E\")"

const BASE_CSS = `
:host { display: block; color: var(--card-text); }
.mn-root { overflow-wrap: break-word; }
.card { background: transparent !important; min-height: 1em; }
.card.nightMode.mn-auto-night { color: var(--card-text) !important; }
img { max-width: 100%; height: auto; border-radius: 10px; }
hr#answer, hr[id="answer"] { border: 0; height: 1px; background: var(--card-separator); margin: 22px 0; }
.mn-audio, .mn-tts {
  display: inline-grid; place-items: center; width: 40px; height: 40px; margin: 2px 4px; padding: 0;
  border: 0; border-radius: 50%; background: var(--card-chip); color: var(--card-accent); cursor: pointer; vertical-align: middle;
}
.mn-audio::before, .mn-tts::before {
  content: ''; width: 20px; height: 20px; background: currentColor;
  -webkit-mask: ${SPEAKER_SVG} center / contain no-repeat; mask: ${SPEAKER_SVG} center / contain no-repeat;
}
.mn-audio:focus-visible, .mn-tts:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid var(--card-accent); outline-offset: 2px; }
.typeans-input {
  display: block; width: 100%; max-width: 440px; margin: 16px auto 0; padding: 12px 16px;
  border: 1px solid var(--card-field-edge); border-radius: 12px; background: var(--card-field-bg);
  color: inherit; font: inherit; font-size: 20px; text-align: center; outline: none;
}
.typeans-input:focus { border-color: var(--card-accent); box-shadow: 0 0 0 3px var(--card-chip); }
.typeans { display: inline-block; margin-top: 8px; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.85em; line-height: 1.6; text-align: center; }
.typeGood { color: var(--good); background: var(--good-tint); border-radius: 3px; }
.typeBad { color: var(--again); background: var(--again-tint); border-radius: 3px; text-decoration: line-through; }
.typeMissed { color: var(--card-secondary); background: rgba(127,127,127,.18); border-radius: 3px; }
.typearrow { color: var(--card-secondary); }
details.hint { display: inline-block; margin: 6px 0; }
details.hint summary { cursor: pointer; color: var(--card-accent); font-size: 0.8em; min-height: 24px; }
.mn-error { color: var(--again); font-size: 14px; }
.mn-missing { display: inline-block; padding: 8px 12px; border-radius: 8px; background: rgba(127,127,127,.15); color: var(--card-secondary); font-size: 14px; }
rt { font-size: 0.55em; }
a { color: var(--card-accent); }
table { border-collapse: collapse; margin: 0 auto; }
`

const cssCache = new Map<string, Promise<string>>()
const injectedFonts = new Set<string>()
const SEL_RE = /(^|[\s,>+~(])(html|body)(?=[\s,.:#[{>+~)]|$)/g
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g

function rewriteSelectors(css: string): string {
  let out = ''
  let buf = ''
  for (const ch of css) {
    if (ch === '{') {
      out += (buf.trim().startsWith('@') ? buf : buf.replace(SEL_RE, '$1.card')) + ch
      buf = ''
    } else if (ch === '}' || ch === ';') {
      out += buf + ch
      buf = ''
    } else {
      buf += ch
    }
  }
  return out + buf
}

async function replaceUrls(css: string): Promise<string> {
  const names = new Set<string>()
  css.replace(URL_RE, (_m, _q, src: string) => {
    if (!isExternalSrc(src.trim())) names.add(src.trim())
    return ''
  })
  const map = new Map<string, string>()
  await Promise.all(
    [...names].map(async (n) => {
      const u = await mediaUrl(safeDecode(n)).catch(() => null)
      if (u) map.set(n, u)
    }),
  )
  return css.replace(URL_RE, (m, _q, src: string) => {
    const u = map.get(src.trim())
    return u ? `url("${u}")` : m
  })
}

/** Note type CSS → CSS usable inside the card's shadow root (fonts are hoisted to the document). */
export function processCardCss(css: string): Promise<string> {
  let p = cssCache.get(css)
  if (!p) {
    p = (async () => {
      let src = css.replace(/\/\*[\s\S]*?\*\//g, '')
      const fonts: string[] = []
      src = src.replace(/@font-face\s*\{[^}]*\}/g, (m) => {
        fonts.push(m)
        return ''
      })
      if (fonts.length) {
        const resolved = await replaceUrls(fonts.join('\n'))
        if (!injectedFonts.has(resolved)) {
          injectedFonts.add(resolved)
          const style = document.createElement('style')
          style.dataset.mnemoFonts = ''
          style.textContent = resolved
          document.head.appendChild(style)
        }
      }
      return replaceUrls(rewriteSelectors(src))
    })()
    cssCache.set(css, p)
    if (cssCache.size > 50) cssCache.delete(cssCache.keys().next().value!)
  }
  return p
}

function handlesNightMode(css: string): boolean {
  return /night[-_]?mode/i.test(css)
}

async function hydrateImages(root: ShadowRoot) {
  const imgs = [...root.querySelectorAll('img')]
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? ''
      if (!src || isExternalSrc(src)) return
      const url = await mediaUrl(safeDecode(src)).catch(() => null)
      if (url) {
        img.src = url
      } else {
        const span = document.createElement('span')
        span.className = 'mn-missing'
        span.textContent = `Нет файла: ${safeDecode(src)}`
        img.replaceWith(span)
      }
    }),
  )
}

/** Plain text of what follows <hr id=answer> (the answer-only part), for speech. */
export function answerOnlyText(root: ShadowRoot | null): string {
  const card = root?.querySelector('.card')
  if (!card) return ''
  const hr = card.querySelector('hr#answer, hr[id="answer"]')
  if (!hr) return (card as HTMLElement).innerText ?? card.textContent ?? ''
  const range = document.createRange()
  range.setStartAfter(hr)
  range.setEndAfter(card.lastChild ?? hr)
  return range.toString()
}

export interface CardViewProps {
  html: string
  css: string
  dark: boolean
  zoom?: number
  /** Called once the content is in place (images may still be loading). */
  onRendered?: (root: ShadowRoot) => void
  onTypedChange?: (v: string) => void
  onTypeEnter?: () => void
  focusTypeInput?: boolean
  scrollToAnswer?: boolean
  label?: string
}

export function CardView({
  html,
  css,
  dark,
  zoom = 1,
  onRendered,
  onTypedChange,
  onTypeEnter,
  focusTypeInput,
  scrollToAnswer,
  label,
}: CardViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const cbs = useRef({ onRendered, onTypedChange, onTypeEnter })
  cbs.current = { onRendered, onTypedChange, onTypeEnter }

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' })
    const night = dark ? ` nightMode night_mode night-mode${handlesNightMode(css) ? '' : ' mn-auto-night'}` : ''
    root.innerHTML = `<style>${BASE_CSS}</style><style data-card></style><div class="mn-root" style="zoom:${zoom}"><div class="card${night}">${html}</div></div>`
    let cancelled = false
    void processCardCss(css).then((processed) => {
      if (cancelled) return
      const style = root.querySelector('style[data-card]')
      if (style) style.textContent = processed
    })
    void hydrateImages(root)

    const onClick = (e: Event) => {
      const t = (e.target as Element).closest?.('.mn-audio, .mn-tts') as HTMLElement | null
      if (!t) return
      e.preventDefault()
      e.stopPropagation()
      if (t.classList.contains('mn-audio')) playSounds([t.dataset.sound ?? ''])
      else speak(t.dataset.text ?? '', t.dataset.lang ?? '', Number(t.dataset.rate ?? 1))
    }
    root.addEventListener('click', onClick)

    const input = root.querySelector<HTMLInputElement>('#typeans')
    const onInput = () => cbs.current.onTypedChange?.(input!.value)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        cbs.current.onTypeEnter?.()
      }
      e.stopPropagation()
    }
    if (input) {
      input.addEventListener('input', onInput)
      input.addEventListener('keydown', onKey)
      if (focusTypeInput) setTimeout(() => input.focus({ preventScroll: true }), 60)
    }
    if (scrollToAnswer) {
      const hr = root.querySelector('hr#answer, hr[id="answer"]')
      if (hr) requestAnimationFrame(() => hr.scrollIntoView({ block: 'start', behavior: 'smooth' }))
    }
    cbs.current.onRendered?.(root)
    return () => {
      cancelled = true
      root.removeEventListener('click', onClick)
      input?.removeEventListener('input', onInput)
      input?.removeEventListener('keydown', onKey)
    }
  }, [html, css, dark, zoom, focusTypeInput, scrollToAnswer])

  return <div ref={host} className="card-host" role="region" aria-label={label ?? 'Карточка'} />
}
