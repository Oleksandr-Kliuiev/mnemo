import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { formatNumber, plural } from '../lib/format'

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function niceMax(v: number): number {
  if (v <= 4) return 4
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p
  return 10 * p
}

function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace('.', ',')}K`
  return String(n)
}

export interface Series {
  key: string
  label: string
  color: string
  values: number[]
}

/** Rounded top (4px) and square base. */
function columnPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return ''
  const rr = Math.min(r, h, w / 2)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

interface TooltipState {
  i: number
  x: number
}

/**
 * Columns, optionally stacked. Hover or arrow keys show the values of a column.
 * One axis; hairline grid; ≤24px columns with a 2px surface gap between stacked parts.
 */
export function ColumnChart({
  labels,
  titles,
  series,
  height = 168,
  ariaLabel,
  highlight,
  emptyText = 'Пока нет данных',
}: {
  labels: string[]
  titles: string[]
  series: Series[]
  height?: number
  ariaLabel: string
  highlight?: number
  emptyText?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [tip, setTip] = useState<TooltipState | null>(null)
  const n = labels.length
  const totals = labels.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0))
  const max = niceMax(Math.max(0, ...totals))
  const padL = 32
  const padB = 22
  const plotW = Math.max(0, width - padL)
  const plotH = height - padB - 8
  const band = n ? plotW / n : 0
  const colW = Math.max(2, Math.min(24, band * 0.62))
  const ticks = [0, max / 2, max]
  const y = (v: number) => 8 + plotH - (v / max) * plotH
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 34))))
  const allZero = totals.every((t) => t === 0)

  const indexAt = (clientX: number) => {
    const el = ref.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left - padL
    const i = Math.floor(x / band)
    return i >= 0 && i < n ? i : null
  }

  const show = (i: number | null) => setTip(i == null ? null : { i, x: padL + i * band + band / 2 })

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <div
          className="chart__plot"
          tabIndex={0}
          role="group"
          aria-label={`${ariaLabel}. Стрелки влево и вправо показывают значения.`}
          onPointerMove={(e) => show(indexAt(e.clientX))}
          onPointerLeave={() => setTip(null)}
          onFocus={() => show(tip?.i ?? highlight ?? n - 1)}
          onBlur={() => setTip(null)}
          onKeyDown={(e) => {
            const cur = tip?.i ?? highlight ?? n - 1
            if (e.key === 'ArrowLeft') show(Math.max(0, cur - 1))
            else if (e.key === 'ArrowRight') show(Math.min(n - 1, cur + 1))
            else if (e.key === 'Home') show(0)
            else if (e.key === 'End') show(n - 1)
            else return
            e.preventDefault()
          }}
        >
          <svg width={width} height={height} aria-hidden>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={width} y1={y(t)} y2={y(t)} className={t === 0 ? 'chart__base' : 'chart__grid'} />
                <text x={padL - 6} y={y(t) + 4} className="chart__tick" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {labels.map((_, i) => {
              let acc = 0
              const x = padL + i * band + (band - colW) / 2
              const parts = series.map((s, si) => {
                const v = s.values[i] ?? 0
                if (!v) return null
                const y0 = y(acc)
                acc += v
                const y1 = y(acc)
                const top = series.slice(si + 1).every((t) => !(t.values[i] ?? 0))
                const h = Math.max(1, y0 - y1 - (acc - v > 0 ? 2 : 0))
                return top ? (
                  <path key={s.key} d={columnPath(x, y1, colW, h, 4)} fill={s.color} />
                ) : (
                  <rect key={s.key} x={x} y={y1} width={colW} height={h} fill={s.color} />
                )
              })
              return (
                <g key={i} className={tip && tip.i !== i ? 'chart__col chart__col--dim' : 'chart__col'}>
                  {parts}
                </g>
              )
            })}
            {highlight != null && highlight >= 0 && highlight < n && (
              <line
                x1={padL + highlight * band + band / 2}
                x2={padL + highlight * band + band / 2}
                y1={height - padB + 2}
                y2={height - padB + 6}
                className="chart__base"
              />
            )}
            {labels.map((l, i) =>
              i === n - 1 || (i % labelEvery === 0 && n - 1 - i >= Math.ceil(labelEvery * 0.75)) ? (
                <text key={i} x={padL + i * band + band / 2} y={height - 6} className="chart__tick" textAnchor="middle">
                  {l}
                </text>
              ) : null,
            )}
            {tip && <line x1={tip.x} x2={tip.x} y1={8} y2={height - padB} className="chart__cross" />}
          </svg>
          {allZero && <div className="chart__empty">{emptyText}</div>}
          {tip && (
            <div className="chart__tip" style={{ left: Math.min(Math.max(tip.x, 70), width - 70) }} role="status">
              <div className="chart__tip-title">{titles[tip.i]}</div>
              {series.length > 1 && (
                <div className="chart__tip-row chart__tip-row--total">
                  <strong>{formatNumber(totals[tip.i])}</strong> всего
                </div>
              )}
              {series.map((s) => (
                <div key={s.key} className="chart__tip-row">
                  <i style={{ background: s.color }} aria-hidden />
                  <strong>{formatNumber(s.values[tip.i] ?? 0)}</strong>
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ ['--c' as string]: s.color }} aria-hidden />
              {s.label} · {formatNumber(s.values.reduce((a, b) => a + b, 0))}
            </span>
          ))}
        </div>
      )}
      <DataTable
        caption={ariaLabel}
        head={['Период', ...series.map((s) => s.label)]}
        rows={labels.map((_, i) => [titles[i], ...series.map((s) => formatNumber(s.values[i] ?? 0))])}
      />
    </div>
  )
}

export function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="chart__table">
      <summary>Таблица</summary>
      <div className="table-scroll">
        <table className="table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j} className="num">{c}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

/** GitHub-style calendar: columns are weeks (Mon–Sun), most recent on the right. */
export function Heatmap({
  data,
  today,
  max,
  dayTitle,
}: {
  data: Map<number, number>
  today: number
  max: number
  dayTitle: (day: number) => string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [tip, setTip] = useState<{ day: number; x: number; y: number } | null>(null)
  const cell = 12
  const gap = 3
  const weeks = Math.max(8, Math.min(53, Math.floor((width + gap) / (cell + gap))))
  // Day 0 (1970-01-01) was a Thursday; (day + 3) % 7 → Monday = 0.
  const weekday = (d: number) => (((d + 3) % 7) + 7) % 7
  const lastCol = today - weekday(today)
  const first = lastCol - (weeks - 1) * 7
  const level = (v: number) => (v <= 0 ? 0 : max <= 4 ? Math.min(4, v) : Math.min(4, Math.ceil((v / max) * 4)))
  const cells: ReactNode[] = []
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const day = first + w * 7 + d
      if (day > today) continue
      const v = data.get(day) ?? 0
      cells.push(
        <rect
          key={day}
          x={w * (cell + gap)}
          y={d * (cell + gap)}
          width={cell}
          height={cell}
          rx={3}
          className={`heat heat--${level(v)}${day === today ? ' heat--today' : ''}`}
          onPointerEnter={() => setTip({ day, x: w * (cell + gap) + cell / 2, y: d * (cell + gap) })}
        />,
      )
    }
  }
  const h = 7 * (cell + gap) - gap
  const tipCount = tip ? (data.get(tip.day) ?? 0) : 0
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <div className="chart__plot" onPointerLeave={() => setTip(null)}>
          <svg width={weeks * (cell + gap) - gap} height={h} role="img" aria-label={`Активность за ${weeks} недель`}>
            {cells}
          </svg>
          {tip && (
            <div className="chart__tip chart__tip--small" style={{ left: Math.min(Math.max(tip.x, 70), width - 70), top: tip.y - 8 }} role="status">
              <strong>{formatNumber(tipCount)}</strong> {plural(tipCount, ['ответ', 'ответа', 'ответов'])} · {dayTitle(tip.day)}
            </div>
          )}
        </div>
      )}
      <div className="legend heat-legend" aria-hidden>
        <span>Меньше</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <svg key={l} width={12} height={12}>
            <rect width={12} height={12} rx={3} className={`heat heat--${l}`} />
          </svg>
        ))}
        <span>Больше</span>
      </div>
    </div>
  )
}

/** 100% stacked bar with a legend that carries the numbers. */
export function PartsBar({ parts, ariaLabel }: { parts: { label: string; value: number; color: string }[]; ariaLabel: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0)
  const [ref, width] = useWidth<HTMLDivElement>()
  const visible = parts.filter((p) => p.value > 0)
  const gaps = Math.max(0, visible.length - 1) * 2
  let x = 0
  return (
    <div className="chart" ref={ref}>
      {width > 0 && total > 0 && (
        <svg width={width} height={16} role="img" aria-label={`${ariaLabel}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
          {visible.map((p, i) => {
            const w = Math.max(2, ((width - gaps) * p.value) / total)
            const el = <rect key={p.label} x={x} y={0} width={w} height={16} rx={i === 0 || i === visible.length - 1 ? 4 : 0} fill={p.color} />
            x += w + 2
            return el
          })}
        </svg>
      )}
      <ul className="parts-legend">
        {parts.map((p) => (
          <li key={p.label}>
            <i style={{ ['--c' as string]: p.color }} aria-hidden />
            <span className="parts-legend__label">{p.label}</span>
            <strong>{formatNumber(p.value)}</strong>
            <span className="parts-legend__pct">{total ? `${Math.round((p.value / total) * 100)} %` : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
