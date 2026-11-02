import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Left side of the header (defaults to a close button on the right). */
  start?: ReactNode
  end?: ReactNode
  full?: boolean
  /** Ask before closing by Escape / backdrop (e.g. unsaved input). */
  confirmClose?: () => Promise<boolean> | boolean
}

/** Bottom sheet built on <dialog>: focus trap, Escape and inert background for free. */
export function Sheet({ open, onClose, title, children, start, end, full, confirmClose }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      opener.current = document.activeElement
      d.showModal()
    } else if (!open && d.open) {
      d.close()
      const o = opener.current as HTMLElement | null
      if (o && document.contains(o)) o.focus({ preventScroll: true })
    }
  }, [open])

  const requestClose = async () => {
    if (confirmClose && !(await confirmClose())) return
    onClose()
  }

  return (
    <dialog
      ref={ref}
      className={`sheet${full ? ' sheet--full' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        void requestClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) void requestClose()
      }}
    >
      {open && (
        <>
          <div className="sheet__grab" aria-hidden />
          <div className="sheet__head">
            <div className="nav__side">{start}</div>
            <h2 className="sheet__title">{title}</h2>
            <div className="nav__side nav__side--end">
              {end ?? (
                <button type="button" className="icon-btn icon-btn--filled" onClick={() => void requestClose()} aria-label="Закрыть">
                  <X size={20} strokeWidth={2.4} aria-hidden />
                </button>
              )}
            </div>
          </div>
          <div className="sheet__body">{children}</div>
        </>
      )}
    </dialog>
  )
}
