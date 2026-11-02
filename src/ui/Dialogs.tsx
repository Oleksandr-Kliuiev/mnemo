import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

export interface DialogButton<T> {
  label: string
  value: T
  kind?: 'cancel' | 'danger' | 'strong'
}

interface DialogSpec {
  title: string
  message?: ReactNode
  buttons: DialogButton<unknown>[]
  input?: { label: string; value: string; placeholder?: string; validate?: (v: string) => string | null }
  stack?: boolean
  id: number
  resolve: (v: unknown) => void
}

interface DialogApi {
  confirm(opts: { title: string; message?: ReactNode; ok: string; cancel?: string; danger?: boolean }): Promise<boolean>
  alert(opts: { title: string; message?: ReactNode; ok?: string }): Promise<void>
  prompt(opts: {
    title: string
    message?: ReactNode
    label: string
    value?: string
    placeholder?: string
    ok: string
    validate?: (v: string) => string | null
  }): Promise<string | null>
  choose<T>(opts: { title: string; message?: ReactNode; options: DialogButton<T>[] }): Promise<T | null>
}

const Ctx = createContext<DialogApi | null>(null)

export function useDialogs(): DialogApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('DialogProvider missing')
  return api
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<DialogSpec[]>([])
  const seq = useRef(0)

  const open = useCallback(<T,>(spec: Omit<DialogSpec, 'resolve' | 'id'>) => {
    return new Promise<T>((resolve) => {
      const id = ++seq.current
      setQueue((q) => [...q, { ...spec, id, resolve: resolve as (v: unknown) => void }])
    })
  }, [])

  const apiRef = useRef<DialogApi>({
    confirm: ({ title, message, ok, cancel = 'Отмена', danger }) =>
      open<boolean>({
        title,
        message,
        buttons: [
          { label: cancel, value: false, kind: 'cancel' },
          { label: ok, value: true, kind: danger ? 'danger' : 'strong' },
        ],
      }),
    alert: ({ title, message, ok = 'Понятно' }) =>
      open<void>({ title, message, buttons: [{ label: ok, value: undefined, kind: 'strong' }] }),
    prompt: ({ title, message, label, value = '', placeholder, ok, validate }) =>
      open<string | null>({
        title,
        message,
        input: { label, value, placeholder, validate },
        buttons: [
          { label: 'Отмена', value: null, kind: 'cancel' },
          { label: ok, value: '__input__', kind: 'strong' },
        ],
      }),
    choose: <T,>({ title, message, options }: { title: string; message?: ReactNode; options: DialogButton<T>[] }) =>
      open<T | null>({
        title,
        message,
        stack: true,
        buttons: [...(options as DialogButton<unknown>[]), { label: 'Отмена', value: null, kind: 'cancel' }],
      }),
  })

  const current = queue[0]
  return (
    <Ctx.Provider value={apiRef.current}>
      {children}
      {current && (
        <AlertDialog
          key={current.id}
          spec={current}
          onDone={(v) => {
            current.resolve(v)
            setQueue((q) => q.slice(1))
          }}
        />
      )}
    </Ctx.Provider>
  )
}

function AlertDialog({ spec, onDone }: { spec: DialogSpec; onDone: (v: unknown) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)
  const [value, setValue] = useState(spec.input?.value ?? '')
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancel = spec.buttons.find((b) => b.kind === 'cancel')

  useEffect(() => {
    const d = ref.current!
    opener.current = document.activeElement
    d.showModal()
    if (spec.input) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    return () => {
      if (d.open) d.close()
      const o = opener.current as HTMLElement | null
      if (o && document.contains(o)) o.focus({ preventScroll: true })
    }
  }, [spec.input])

  const finish = (b: DialogButton<unknown>) => {
    if (b.value === '__input__') {
      const v = value.trim()
      const err = spec.input?.validate?.(v) ?? (v ? null : 'Введите значение')
      if (err) {
        setTouched(true)
        setError(err)
        inputRef.current?.focus()
        return
      }
      onDone(v)
      return
    }
    onDone(b.value)
  }

  const titleId = 'dlg-title'
  const msgId = 'dlg-msg'
  return (
    <dialog
      ref={ref}
      className="alert"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={spec.message ? msgId : undefined}
      onCancel={(e) => {
        e.preventDefault()
        onDone(cancel ? cancel.value : spec.buttons[0].value)
      }}
    >
      <form
        method="dialog"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          const strong = spec.buttons.find((b) => b.value === '__input__') ?? spec.buttons[spec.buttons.length - 1]
          finish(strong)
        }}
      >
        <div className="alert__body">
          <h2 className="alert__title" id={titleId}>
            {spec.title}
          </h2>
          {spec.message && (
            <div className="alert__text" id={msgId}>
              {spec.message}
            </div>
          )}
          {spec.input && (
            <div className="alert__field field">
              <label className="sr-only" htmlFor="dlg-input">
                {spec.input.label}
              </label>
              <input
                id="dlg-input"
                ref={inputRef}
                className="input"
                value={value}
                placeholder={spec.input.placeholder}
                aria-invalid={touched && !!error}
                aria-describedby={error ? 'dlg-err' : undefined}
                autoComplete="off"
                onChange={(e) => {
                  setValue(e.target.value)
                  if (touched) setError(spec.input?.validate?.(e.target.value.trim()) ?? null)
                }}
                onBlur={() => {
                  if (value.trim()) {
                    setTouched(true)
                    setError(spec.input?.validate?.(value.trim()) ?? null)
                  }
                }}
              />
              {touched && error && (
                <p className="field__error" id="dlg-err" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
        <div className={`alert__buttons${spec.stack || spec.buttons.length > 2 ? ' alert__buttons--stack' : ''}`}>
          {spec.buttons.map((b, i) => (
            <button
              key={i}
              type={b.value === '__input__' ? 'submit' : 'button'}
              className={`alert__btn${b.kind === 'strong' ? ' alert__btn--strong' : ''}${b.kind === 'danger' ? ' alert__btn--danger alert__btn--strong' : ''}`}
              autoFocus={!spec.input && b.kind === 'cancel'}
              onClick={(e) => {
                if (b.value === '__input__') return
                e.preventDefault()
                finish(b)
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      </form>
    </dialog>
  )
}
