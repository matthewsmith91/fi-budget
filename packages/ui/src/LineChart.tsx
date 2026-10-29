import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { niceAxis, spreadIndexes } from './chart-scale.ts'

export interface ChartSeries {
  label: string
  /** One value per x position. */
  values: readonly number[]
  /** Any CSS color; pass a custom property so light and dark follow the page. */
  color: string
}

export interface LineChartProps {
  /** Short x labels for the axis, one per position. */
  labels: readonly string[]
  /** Longer ones for the tooltip; defaults to `labels`. */
  detailLabels?: readonly string[]
  series: readonly ChartSeries[]
  /** A value as the tooltip shows it. */
  formatValue: (value: number) => string
  /** A value on the y axis and beside each line's end; short, like `$1.2M`. */
  formatTick: (value: number) => string
  /** What the chart shows, for screen readers. The data also belongs in a table beside it. */
  ariaLabel: string
  height?: number
}

const MARGIN = { top: 14, right: 64, bottom: 24, left: 52 }

/**
 * A line chart that fills its container: hairline grid, 2px lines, an end dot and value on
 * each line, and a crosshair with one tooltip for every series. It follows the pointer or the
 * arrow keys. Colors come from the CSS custom properties `--surface`, `--line`, `--fg` and
 * `--muted`, so the page decides light or dark.
 */
export function LineChart(props: LineChartProps) {
  const { labels, series, height = 240 } = props
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [active, setActive] = useState<number | null>(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const n = labels.length
  const all = series.flatMap((s) => s.values)
  const axis = all.length ? niceAxis(Math.min(...all), Math.max(...all)) : niceAxis(0, 0)
  const inner = {
    w: Math.max(width - MARGIN.left - MARGIN.right, 1),
    h: height - MARGIN.top - MARGIN.bottom,
  }
  const x = (i: number) => MARGIN.left + (n <= 1 ? inner.w / 2 : (i * inner.w) / (n - 1))
  const y = (v: number) => MARGIN.top + inner.h - ((v - axis.min) / (axis.max - axis.min)) * inner.h

  function nearest(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - box.left - MARGIN.left) / inner.w
    setActive(Math.min(Math.max(Math.round(ratio * (n - 1)), 0), n - 1))
  }

  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') setActive(Math.min((active ?? -1) + 1, n - 1))
    else if (e.key === 'ArrowLeft') setActive(Math.max((active ?? n) - 1, 0))
    else if (e.key === 'Escape') setActive(null)
    else return
    e.preventDefault()
  }

  // End values only where they don't sit on top of each other.
  const ends = series
    .map((s, k) => ({ k, top: y(s.values[n - 1] ?? 0) }))
    .sort((a, b) => a.top - b.top)
  const labelled = new Set<number>()
  let last = -Infinity
  for (const e of ends) {
    if (e.top - last >= 16) {
      labelled.add(e.k)
      last = e.top
    }
  }

  const detail = props.detailLabels ?? labels
  const tipLeft = active === null ? 0 : x(active)
  const flip = tipLeft > width * 0.6

  return (
    <figure style={{ margin: 0 }}>
      {series.length > 1 && (
        <ul
          aria-label="Legend"
          style={{
            display: 'flex',
            gap: '1rem',
            listStyle: 'none',
            margin: '0 0 0.4rem',
            padding: 0,
          }}
        >
          {series.map((s) => (
            <li key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <svg width="16" height="8" aria-hidden="true">
                <line
                  x1="0"
                  x2="16"
                  y1="4"
                  y2="4"
                  stroke={s.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              <small>{s.label}</small>
            </li>
          ))}
        </ul>
      )}
      <div ref={wrap} style={{ position: 'relative', width: '100%', height }}>
        {width > 0 && n > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={props.ariaLabel}
            tabIndex={0}
            onPointerMove={nearest}
            onPointerLeave={() => setActive(null)}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
            style={{ display: 'block', touchAction: 'pan-y', overflow: 'visible' }}
          >
            {axis.ticks.map((t) => (
              <g key={t}>
                <line
                  x1={MARGIN.left}
                  x2={MARGIN.left + inner.w}
                  y1={y(t)}
                  y2={y(t)}
                  stroke="var(--line)"
                  strokeWidth="1"
                />
                <text
                  x={MARGIN.left - 8}
                  y={y(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize="11"
                  fill="var(--muted)"
                >
                  {props.formatTick(t)}
                </text>
              </g>
            ))}
            {spreadIndexes(n, Math.min(n, Math.max(Math.floor(inner.w / 90), 2))).map((i) => (
              <text
                key={i}
                x={x(i)}
                y={height - 6}
                textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}
                fontSize="11"
                fill="var(--muted)"
              >
                {labels[i]}
              </text>
            ))}
            {series.map((s) => (
              <polyline
                key={s.label}
                points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {series.map((s, k) => {
              const value = s.values[n - 1]
              if (value === undefined) return null
              return (
                <g key={s.label}>
                  <circle
                    cx={x(n - 1)}
                    cy={y(value)}
                    r="4"
                    fill={s.color}
                    stroke="var(--surface)"
                    strokeWidth="2"
                  />
                  {labelled.has(k) && (
                    <text
                      x={x(n - 1) + 10}
                      y={y(value)}
                      dominantBaseline="middle"
                      fontSize="11"
                      fill="var(--fg)"
                    >
                      {props.formatTick(value)}
                    </text>
                  )}
                </g>
              )
            })}
            {active !== null && (
              <g pointerEvents="none">
                <line
                  x1={x(active)}
                  x2={x(active)}
                  y1={MARGIN.top}
                  y2={MARGIN.top + inner.h}
                  stroke="var(--muted)"
                  strokeWidth="1"
                />
                {series.map((s) => (
                  <circle
                    key={s.label}
                    cx={x(active)}
                    cy={y(s.values[active] ?? 0)}
                    r="4"
                    fill={s.color}
                    stroke="var(--surface)"
                    strokeWidth="2"
                  />
                ))}
              </g>
            )}
          </svg>
        )}
        {active !== null && (
          <div
            role="status"
            style={{
              position: 'absolute',
              top: MARGIN.top,
              left: tipLeft,
              transform: flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
              background: 'var(--surface)',
              color: 'var(--fg)',
              border: '1px solid var(--line)',
              borderRadius: '0.4rem',
              padding: '0.4rem 0.6rem',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              boxShadow: '0 2px 8px rgb(0 0 0 / 0.15)',
            }}
          >
            <small style={{ color: 'var(--muted)' }}>{detail[active]}</small>
            {series.map((s) => (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <svg width="12" height="8" aria-hidden="true">
                  <line
                    x1="0"
                    x2="12"
                    y1="4"
                    y2="4"
                    stroke={s.color}
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <strong>{props.formatValue(s.values[active] ?? 0)}</strong>
                {series.length > 1 && <small style={{ color: 'var(--muted)' }}>{s.label}</small>}
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  )
}
