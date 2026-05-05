'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CalendarDays, ExternalLink, Github, Repeat2, Trophy, Users } from 'lucide-react'
import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { SiteFooter } from '@/components/site-footer'
import { cn } from '@/lib/utils'
import { useTopApplicationsLive } from '@/hooks/use-top-applications-live'

const TRACKS = ['All', 'Agent Services', 'Social & Coord', 'Economy & Markets', 'Open / Creative']
const DAY_MS = 86_400_000

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatChartDate(label: string) {
  const date = new Date(`${label}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return label

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function addDays(label: string, days: number) {
  const date = new Date(`${label}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return dateKey(date)
}

function daysBetween(from: string, to: string) {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS))
}

function rangeDates(from: string, to: string) {
  const days = daysBetween(from, to)
  return Array.from({ length: days + 1 }, (_, index) => addDays(from, index))
}

function smoothPath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`

  return points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`

    const previous = points[index - 1]
    const midX = (previous.x + point.x) / 2
    return `${path} C ${midX} ${previous.y}, ${midX} ${point.y}, ${point.x} ${point.y}`
  }, '')
}

function formatLastActive(value: number | null) {
  if (!value) return 'No external use yet'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function shortDescription(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return 'Registered on-chain application.'
  const first = trimmed.split(/[.!?]/)[0]
  return first.length > 120 ? `${first.slice(0, 117)}...` : `${first}.`
}

function rankClass(rank: number) {
  if (rank === 1) return 'border-yellow-400/40 bg-yellow-400/10 text-yellow-200'
  if (rank === 2) return 'border-slate-300/40 bg-slate-300/10 text-slate-100'
  if (rank === 3) return 'border-amber-500/40 bg-amber-500/10 text-amber-200'
  return 'border-border bg-secondary/40 text-muted-foreground'
}

function openDatePicker(input: HTMLInputElement | null) {
  if (!input) return
  input.focus()
  const picker = input as HTMLInputElement & { showPicker?: () => void }
  if (picker.showPicker) {
    picker.showPicker()
  }
}

export default function TopApplicationsLivePage() {
  const { items, loading } = useTopApplicationsLive()
  const [track, setTrack] = useState('All')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [hoveredPoint, setHoveredPoint] = useState<{
    date: string
    transactions: number
    x: number
    y: number
  } | null>(null)
  const dateFromRef = useRef<HTMLInputElement>(null)
  const dateToRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(
    () => items.filter((item) => track === 'All' || item.track === track),
    [items, track],
  )

  const totals = useMemo(() => ({
    apps: filtered.length,
    users: filtered.reduce((sum, item) => sum + item.uniqueUsers, 0),
    returning: filtered.reduce((sum, item) => sum + item.returningUsers, 0),
    activeDays: filtered.reduce((sum, item) => sum + item.activeDays, 0),
  }), [filtered])
  const activityByDate = useMemo(() => {
    const byDate = new Map<string, number>()

    for (const item of filtered) {
      for (const point of item.activityByDay) {
        byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.transactions)
      }
    }

    return byDate
  }, [filtered])
  const availableDates = useMemo(
    () => [...activityByDate.keys()].sort((a, b) => a.localeCompare(b)),
    [activityByDate],
  )
  const maxAvailableDate = availableDates.at(-1) ?? dateKey(new Date())
  const minAvailableDate = availableDates[0] ?? addDays(maxAvailableDate, -13)
  const effectiveTo = dateTo || maxAvailableDate
  const effectiveFrom = dateFrom || addDays(effectiveTo, -13)
  const safeFrom = effectiveFrom > effectiveTo ? effectiveTo : effectiveFrom
  const safeTo = effectiveTo < safeFrom ? safeFrom : effectiveTo
  const activitySeries = useMemo(
    () => rangeDates(safeFrom, safeTo).map((date) => ({
      date,
      transactions: activityByDate.get(date) ?? 0,
    })),
    [activityByDate, safeFrom, safeTo],
  )
  const maxTransactions = Math.max(1, ...activitySeries.map((point) => point.transactions))
  const totalTransactions = activitySeries.reduce((sum, point) => sum + point.transactions, 0)
  const chartWidth = 720
  const chartHeight = 220
  const chartPadX = 26
  const chartPadY = 22
  const chartInnerWidth = chartWidth - chartPadX * 2
  const chartInnerHeight = chartHeight - chartPadY * 2
  const pointStep = activitySeries.length > 1 ? chartInnerWidth / (activitySeries.length - 1) : chartInnerWidth
  const linePoints = activitySeries.map((point, index) => {
    const x = activitySeries.length === 1 ? chartPadX + chartInnerWidth / 2 : chartPadX + index * pointStep
    const y = chartPadY + chartInnerHeight - (point.transactions / maxTransactions) * chartInnerHeight
    return { x, y, ...point }
  })
  const linePath = smoothPath(linePoints)
  const areaPath = linePoints.length
    ? `${linePath} L ${linePoints.at(-1)?.x} ${chartPadY + chartInnerHeight} L ${linePoints[0].x} ${chartPadY + chartInnerHeight} Z`
    : ''
  const setPreset = (days: number | 'all') => {
    if (days === 'all') {
      setDateFrom(minAvailableDate)
      setDateTo(maxAvailableDate)
      return
    }
    setDateTo(maxAvailableDate)
    setDateFrom(addDays(maxAvailableDate, -(days - 1)))
  }

  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>

      <main className="page">
        <section className="section">
          <div className="section__hdr">
            <div>
              <div className="section__kicker">Hackathon</div>
              <h1 className="section__title">top applications · live</h1>
              <p className="section__sub max-w-3xl">
                Ranked by external wallet usage, returning users, and active days. Raw transaction volume is intentionally not the main signal.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
              <span className="live-dot h-2 w-2 rounded-full bg-primary" />
              Live indexer
            </div>
          </div>

          <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card/70">
            <div className="flex flex-col gap-4 border-b border-border bg-secondary/20 p-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Transactions by day
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  External wallet actions for the current track filter.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  onClick={() => setPreset(7)}
                  type="button"
                >
                  7D
                </button>
                <button
                  className="rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  onClick={() => setPreset(14)}
                  type="button"
                >
                  14D
                </button>
                <button
                  className="rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  onClick={() => setPreset('all')}
                  type="button"
                >
                  All
                </button>
                <label
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/50"
                  onClick={() => openDatePicker(dateFromRef.current)}
                >
                  From
                  <input
                    className="bg-transparent font-mono text-foreground outline-none"
                    max={safeTo}
                    min={minAvailableDate}
                    onChange={(event) => setDateFrom(event.target.value)}
                    onClick={(event) => {
                      event.stopPropagation()
                      openDatePicker(event.currentTarget)
                    }}
                    ref={dateFromRef}
                    type="date"
                    value={safeFrom}
                  />
                </label>
                <label
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/50"
                  onClick={() => openDatePicker(dateToRef.current)}
                >
                  To
                  <input
                    className="bg-transparent font-mono text-foreground outline-none"
                    max={maxAvailableDate}
                    min={safeFrom}
                    onChange={(event) => setDateTo(event.target.value)}
                    onClick={(event) => {
                      event.stopPropagation()
                      openDatePicker(event.currentTarget)
                    }}
                    ref={dateToRef}
                    type="date"
                    value={safeTo}
                  />
                </label>
              </div>
            </div>

            {activitySeries.every((point) => point.transactions === 0) ? (
              <div className="m-4 flex h-56 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
                No external transactions yet.
              </div>
            ) : (
              <div className="p-4">
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md border border-border bg-background/70 p-3">
                    <div className="text-xs text-muted-foreground">Transactions</div>
                    <strong className="mt-1 block font-mono text-2xl text-foreground">{formatNumber(totalTransactions)}</strong>
                  </div>
                  <div className="rounded-md border border-border bg-background/70 p-3">
                    <div className="text-xs text-muted-foreground">Peak day</div>
                    <strong className="mt-1 block font-mono text-2xl text-foreground">{formatNumber(maxTransactions)}</strong>
                  </div>
                  <div className="rounded-md border border-border bg-background/70 p-3">
                    <div className="text-xs text-muted-foreground">Range</div>
                    <strong className="mt-1 block font-mono text-sm text-foreground">
                      {formatChartDate(safeFrom)} - {formatChartDate(safeTo)}
                    </strong>
                  </div>
                </div>

                <div className="relative overflow-x-auto">
                  <svg
                    className="min-w-[680px] overflow-visible"
                    onMouseLeave={() => setHoveredPoint(null)}
                    role="img"
                    viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                  >
                    <defs>
                      <linearGradient id="activityArea" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.12" />
                        <stop offset="72%" stopColor="var(--primary)" stopOpacity="0.035" />
                        <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                      const y = chartPadY + ratio * chartInnerHeight
                      return (
                        <line
                          key={ratio}
                          stroke="var(--border)"
                          strokeDasharray={ratio === 1 ? '0' : '4 6'}
                          strokeOpacity="0.38"
                          x1={chartPadX}
                          x2={chartPadX + chartInnerWidth}
                          y1={y}
                          y2={y}
                        />
                      )
                    })}
                    {areaPath && <path d={areaPath} fill="url(#activityArea)" />}
                    {linePath && (
                      <>
                        <path
                          d={linePath}
                          fill="none"
                          opacity="0.14"
                          stroke="var(--primary)"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="5"
                        />
                        <path
                          d={linePath}
                          fill="none"
                          opacity="0.78"
                          stroke="var(--primary)"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                        />
                      </>
                    )}
                    {linePoints.map((point) => (
                      <g key={point.date}>
                        <line
                          opacity={hoveredPoint?.date === point.date ? 0.28 : 0}
                          stroke="var(--primary)"
                          strokeDasharray="3 5"
                          x1={point.x}
                          x2={point.x}
                          y1={chartPadY}
                          y2={chartPadY + chartInnerHeight}
                        />
                        <circle
                          cx={point.x}
                          cy={point.y}
                          fill="var(--background)"
                          opacity="0.86"
                          r={hoveredPoint?.date === point.date ? 4.5 : 3.25}
                          stroke="var(--primary)"
                          strokeWidth="1.5"
                        />
                        <circle
                          cx={point.x}
                          cy={point.y}
                          fill="transparent"
                          onMouseEnter={() => setHoveredPoint(point)}
                          onMouseMove={() => setHoveredPoint(point)}
                          r="14"
                        >
                          <title>{`${point.date}: ${formatNumber(point.transactions)} transactions`}</title>
                        </circle>
                      </g>
                    ))}
                  </svg>
                  {hoveredPoint && (
                    <div
                      className="pointer-events-none absolute z-10 rounded-md border border-primary/30 bg-background/95 px-3 py-2 text-xs shadow-lg shadow-black/30"
                      style={{
                        left: `min(calc(100% - 148px), max(8px, calc(${(hoveredPoint.x / chartWidth) * 100}% - 58px)))`,
                        top: `${Math.max(8, hoveredPoint.y - 10)}px`,
                      }}
                    >
                      <div className="font-mono text-foreground">{formatChartDate(hoveredPoint.date)}</div>
                      <div className="mt-1 text-muted-foreground">
                        <span className="font-mono text-primary">{formatNumber(hoveredPoint.transactions)}</span>
                        {' '}transactions
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-3 flex justify-between gap-3 font-mono text-[10px] text-muted-foreground">
                  <span>{formatChartDate(safeFrom)}</span>
                  <span>{formatChartDate(safeTo)}</span>
                </div>
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-border bg-card/70 p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Trophy className="h-4 w-4 text-primary" />
                Applications
              </div>
              <strong className="mt-3 block text-3xl text-foreground">{formatNumber(totals.apps)}</strong>
            </div>
            <div className="rounded-lg border border-border bg-card/70 p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Users className="h-4 w-4 text-primary" />
                Unique users
              </div>
              <strong className="mt-3 block text-3xl text-foreground">{formatNumber(totals.users)}</strong>
            </div>
            <div className="rounded-lg border border-border bg-card/70 p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Repeat2 className="h-4 w-4 text-primary" />
                Returning users
              </div>
              <strong className="mt-3 block text-3xl text-foreground">{formatNumber(totals.returning)}</strong>
            </div>
            <div className="rounded-lg border border-border bg-card/70 p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CalendarDays className="h-4 w-4 text-primary" />
                Active days
              </div>
              <strong className="mt-3 block text-3xl text-foreground">{formatNumber(totals.activeDays)}</strong>
            </div>
          </div>
        </section>

        <section className="section pt-0">
          <div className="mb-5 flex flex-wrap gap-2">
            {TRACKS.map((item) => (
              <button
                className={cn(
                  'rounded-full border px-3 py-1.5 text-sm transition-colors',
                  track === item
                    ? 'border-primary/60 bg-primary/15 text-primary'
                    : 'border-border bg-card/70 text-muted-foreground hover:border-primary/40 hover:text-foreground',
                )}
                key={item}
                onClick={() => setTrack(item)}
                type="button"
              >
                {item}
              </button>
            ))}
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card/70">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/30 text-left text-xs text-muted-foreground">
                    <th className="w-16 px-4 py-3 font-medium">Rank</th>
                    <th className="px-4 py-3 font-medium">Application</th>
                    <th className="px-4 py-3 text-right font-medium">Live score</th>
                    <th className="px-4 py-3 text-right font-medium">Users</th>
                    <th className="px-4 py-3 text-right font-medium">Returning</th>
                    <th className="px-4 py-3 text-right font-medium">Active days</th>
                    <th className="px-4 py-3 font-medium">Last active</th>
                    <th className="px-4 py-3 text-right font-medium">GitHub</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && filtered.length === 0 && Array.from({ length: 6 }, (_, index) => (
                    <tr className="border-b border-border/50 last:border-0" key={index}>
                      <td colSpan={8} className="px-4 py-4">
                        <div className="h-8 animate-pulse rounded-md bg-secondary/70" />
                      </td>
                    </tr>
                  ))}

                  {!loading && filtered.length === 0 && (
                    <tr>
                      <td className="px-4 py-12 text-center text-muted-foreground" colSpan={8}>
                        No live application activity for this filter yet.
                      </td>
                    </tr>
                  )}

                  {filtered.map((item, index) => {
                    const rank = index + 1
                    return (
                      <tr
                        className="border-b border-border/50 transition-colors last:border-0 hover:bg-secondary/20"
                        key={item.applicationId}
                      >
                        <td className="px-4 py-4 align-top">
                          <span className={cn('inline-flex h-8 min-w-8 items-center justify-center rounded-full border px-2 font-mono text-xs', rankClass(rank))}>
                            {rank}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex flex-col gap-2">
                            <div>
                              <div className="font-semibold text-foreground">{item.displayName}</div>
                              <div className="font-mono text-xs text-muted-foreground">{item.handle}</div>
                            </div>
                            <p className="max-w-xl text-sm text-muted-foreground">{shortDescription(item.description)}</p>
                            <div className="flex flex-wrap gap-1.5">
                              <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs text-primary">
                                {item.track}
                              </span>
                              {item.badges.slice(0, 3).map((badge) => (
                                <span className="rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-xs text-muted-foreground" key={badge}>
                                  {badge}
                                </span>
                              ))}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-right align-top font-mono text-base font-semibold text-foreground">
                          {formatNumber(item.score)}
                        </td>
                        <td className="px-4 py-4 text-right align-top font-mono text-muted-foreground">
                          {formatNumber(item.uniqueUsers)}
                        </td>
                        <td className="px-4 py-4 text-right align-top">
                          <div className="font-mono text-muted-foreground">{formatNumber(item.returningUsers)}</div>
                          <div className="text-xs text-muted-foreground">{item.retentionPct}%</div>
                        </td>
                        <td className="px-4 py-4 text-right align-top font-mono text-muted-foreground">
                          {formatNumber(item.activeDays)}
                        </td>
                        <td className="px-4 py-4 align-top text-muted-foreground">
                          {formatLastActive(item.lastActiveAt)}
                        </td>
                        <td className="px-4 py-4 text-right align-top">
                          {item.githubUrl ? (
                            <Link
                              aria-label={`Open ${item.displayName} on GitHub`}
                              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                              href={item.githubUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              <Github className="h-4 w-4" />
                            </Link>
                          ) : (
                            <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary/30 text-muted-foreground">
                              <ExternalLink className="h-4 w-4 opacity-30" />
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Live score favors broad usage and repeat external wallets. Active days require at least 3 external actions from at least 2 wallets.
          </p>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
