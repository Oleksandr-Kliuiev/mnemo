import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

interface ToastItem {
  id: number
  text: ReactNode
  action?: { label: string; run: () => void }
}

interface ToastApi {
  show(text: ReactNode, opts?: { action?: { label: string; run: () => void }; duration?: number }): void
}

const Ctx = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('ToastProvider missing')
  return api
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), [])

  const api = useRef<ToastApi>({
    show: (text, opts = {}) => {
      const id = ++seq.current
      setItems((xs) => [...xs.slice(-2), { id, text, action: opts.action }])
      window.setTimeout(() => dismiss(id), opts.duration ?? (opts.action ? 6000 : 3200))
    },
  })

  return (
    <Ctx.Provider value={api.current}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast">
            <span className="toast__text">{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action!.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
