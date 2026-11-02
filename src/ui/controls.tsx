import { useId, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { href } from '../lib/router'

export function Switch({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  id?: string
}) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className="switch"
      checked={checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string; aria?: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} aria-label={o.aria} title={o.aria} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

interface RowBase {
  title: ReactNode
  sub?: ReactNode
  value?: ReactNode
  icon?: ReactNode
  iconColor?: string
  tone?: 'danger' | 'accent'
  chevron?: boolean
  end?: ReactNode
}

function RowInner({ title, sub, value, icon, iconColor, chevron, end }: RowBase) {
  return (
    <>
      {icon && (
        <span className="row__icon" style={iconColor ? { background: iconColor } : undefined} aria-hidden>
          {icon}
        </span>
      )}
      <span className="row__body">
        <span className="row__title">{title}</span>
        {sub && <span className="row__sub">{sub}</span>}
      </span>
      {value !== undefined && <span className="row__value">{value}</span>}
      {end}
      {chevron && <ChevronRight className="row__chev" size={20} aria-hidden />}
    </>
  )
}

export function LinkRow({ to, ...p }: RowBase & { to: string }) {
  return (
    <a className={`row${p.icon ? ' row--icon' : ''}${p.tone ? ` row--${p.tone}` : ''}`} href={href(to)}>
      <RowInner chevron {...p} />
    </a>
  )
}

export function ButtonRow({
  onClick,
  disabled,
  label,
  ...p
}: RowBase & { onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      className={`row${p.icon ? ' row--icon' : ''}${p.tone ? ` row--${p.tone}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      <RowInner {...p} />
    </button>
  )
}

export function StaticRow(p: RowBase) {
  return (
    <div className={`row${p.icon ? ' row--icon' : ''}`}>
      <RowInner {...p} />
    </div>
  )
}

export function SwitchRow({
  title,
  sub,
  checked,
  onChange,
  icon,
  iconColor,
}: {
  title: string
  sub?: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  icon?: ReactNode
  iconColor?: string
}) {
  const id = useId()
  return (
    <div className={`row${icon ? ' row--icon' : ''}`}>
      {icon && (
        <span className="row__icon" style={iconColor ? { background: iconColor } : undefined} aria-hidden>
          {icon}
        </span>
      )}
      <label className="row__body" htmlFor={id}>
        <span className="row__title">{title}</span>
        {sub && <span className="row__sub">{sub}</span>}
      </label>
      <Switch id={id} checked={checked} onChange={onChange} label={title} />
    </div>
  )
}

/** Number with − / + buttons; typing is allowed too. */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 9999,
  step = 1,
  label,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  label: string
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button type="button" className="stepper__btn" aria-label={`Уменьшить: ${label}`} onClick={() => onChange(clamp(value - step))} disabled={value <= min}>
        −
      </button>
      <input
        className="stepper__input"
        inputMode="numeric"
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/\D/g, ''))
          if (Number.isFinite(n)) onChange(clamp(n))
        }}
      />
      <button type="button" className="stepper__btn" aria-label={`Увеличить: ${label}`} onClick={() => onChange(clamp(value + step))} disabled={value >= max}>
        +
      </button>
    </span>
  )
}

export function Counts({ n, l, r, label }: { n: number; l: number; r: number; label?: string }) {
  const aria = label ?? `Новых: ${n}, изучаемых: ${l}, к повторению: ${r}`
  return (
    <span className="counts" aria-label={aria} role="img">
      <span className={`count count--new${n ? '' : ' count--zero'}`}>{n}</span>
      <span className={`count count--learn${l ? '' : ' count--zero'}`}>{l}</span>
      <span className={`count count--review${r ? '' : ' count--zero'}`}>{r}</span>
    </span>
  )
}

export function DeckBadge({ color, emoji, name, size }: { color: string; emoji: string; name: string; size?: 'small' | 'large' }) {
  const letter = name.trim().charAt(0).toUpperCase() || '•'
  return (
    <span className={`deck-badge${size ? ` deck-badge--${size}` : ''}`} style={{ ['--deck-color' as string]: color }} aria-hidden>
      {emoji || letter}
    </span>
  )
}

export function EmptyState({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode
  title: string
  text?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty__art" aria-hidden>
        {icon}
      </div>
      <h2 className="empty__title">{title}</h2>
      {text && <p className="empty__text">{text}</p>}
      {children && <div className="empty__actions">{children}</div>}
    </div>
  )
}

export function Loading() {
  return (
    <div className="loading" role="status" aria-label="Загрузка">
      <div className="spinner" />
    </div>
  )
}
