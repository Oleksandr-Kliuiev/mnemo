import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { goBack } from '../lib/router'

export interface BackLink {
  label: string
  /** Route used when there is no in-app history to go back to. */
  fallback: string
  onClick?: () => void
}

interface ScreenProps {
  title: string
  /** Shown as a big heading under the bar (iOS large title). */
  large?: boolean
  subtitle?: ReactNode
  back?: BackLink
  start?: ReactNode
  actions?: ReactNode
  children: ReactNode
  /** Document title, defaults to `title`. */
  docTitle?: string
}

export function useDocTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} — Mnemo` : 'Mnemo'
  }, [title])
}

export function Screen({ title, large = true, subtitle, back, start, actions, children, docTitle }: ScreenProps) {
  useDocTitle(docTitle ?? title)
  const sentinel = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const el = sentinel.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setScrolled(!e.isIntersecting), { rootMargin: '-60px 0px 0px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <>
      <header className={`nav${scrolled ? ' nav--scrolled' : ''}${large ? '' : ' nav--always-title nav--solid'}`}>
        <div className="nav__bar">
          <div className="nav__side">
            {back && (
              <button
                type="button"
                className="nav-btn nav-btn--back"
                onClick={() => (back.onClick ? back.onClick() : goBack(back.fallback))}
                aria-label={`Назад: ${back.label}`}
              >
                <ChevronLeft size={26} strokeWidth={2.4} aria-hidden />
                <span>{back.label}</span>
              </button>
            )}
            {start}
          </div>
          <div className="nav__title" aria-hidden={large && !scrolled}>
            {title}
          </div>
          <div className="nav__side nav__side--end">{actions}</div>
        </div>
      </header>
      <main className="page" id="main">
        {large && (
          <h1 className="large-title">
            {title}
            {subtitle && <span className="large-title__sub">{subtitle}</span>}
          </h1>
        )}
        {!large && <h1 className="sr-only">{title}</h1>}
        <div ref={sentinel} aria-hidden style={{ height: 0 }} />
        {children}
      </main>
    </>
  )
}

export function Section({
  title,
  action,
  footer,
  children,
  big,
  id,
}: {
  title?: ReactNode
  action?: ReactNode
  footer?: ReactNode
  children: ReactNode
  big?: boolean
  id?: string
}) {
  return (
    <section className="section" aria-labelledby={title && id ? id : undefined}>
      {(title || action) && (
        <div className="section__head">
          {title && (
            <h2 className={`section__title${big ? ' section__title--big' : ''}`} id={id}>
              {title}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
      {footer && <p className="section__foot">{footer}</p>}
    </section>
  )
}
