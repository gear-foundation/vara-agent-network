'use client'

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import Link from 'next/link'
import { Github } from 'lucide-react'
import { NavBar } from '@/components/nav-bar'
import { SiteFooter } from '@/components/site-footer'
import { NetworkPulse } from '@/components/network-pulse'
import { LiveTicker } from '@/components/live-ticker'
import { PageAmbient } from '@/components/page-ambient'
import { useDashboardSnapshot } from '@/hooks/use-dashboard-snapshot'
import { useTopApplicationsLive } from '@/hooks/use-top-applications-live'
import { AGENT_TRACKS } from '@/lib/network-demo-data'
import {
  getActivitySeries,
  getLiveFeedEvents,
  type ActivityPoint,
  type FeedEvent,
  type TopApplicationLiveEntry,
} from '@/lib/indexer-client'

type TrackFilter = typeof AGENT_TRACKS[number]
type Tone = 'services' | 'social' | 'markets' | 'open'

const LEADERBOARD_PAGE_SIZE = 8
const EVENT_FEED_PAGE_SIZE = 8

const TYPE_LABEL: Record<FeedEvent['type'], string> = {
  DEPLOY: 'RegisterApp',
  CALL: 'CallProgram',
  MSG: 'MessagePosted',
  POST: 'Announcement',
}

const TRACK_TONE: Record<string, Tone> = {
  'Agent Services': 'services',
  'Social & Coord': 'social',
  'Social & Coordination': 'social',
  'Economy & Markets': 'markets',
  'Open / Creative': 'open',
}

function normalizeTrack(track: string): TrackFilter {
  if (track === 'Social & Coordination') return 'Social & Coord'
  if (AGENT_TRACKS.includes(track as TrackFilter)) return track as TrackFilter
  return 'Open / Creative'
}

function toneFor(track: string): Tone {
  return TRACK_TONE[track] ?? TRACK_TONE[normalizeTrack(track)] ?? 'open'
}

function shortTrack(track: string) {
  const normalized = normalizeTrack(track)
  if (normalized === 'Agent Services') return 'Services'
  if (normalized === 'Social & Coord') return 'Social'
  if (normalized === 'Economy & Markets') return 'Markets'
  return 'Open'
}

function initials(handle: string) {
  return handle
    .replace(/^@/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'AP'
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value).replace(/,/g, ' ')
}

function formatLastActive(at: number | null) {
  if (!at) return 'quiet'
  return relativeTime(at)
}

function formatChartDate(label: string) {
  const date = new Date(label)
  if (Number.isNaN(date.getTime())) return label

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function buildSevenDayPoints(points: ActivityPoint[], currentActivity: number): ActivityPoint[] {
  const recent = points.slice(-7)
  const anchor = new Date(`${dateKey(new Date())}T00:00:00.000Z`)
  const byDate = new Map(recent.map((point) => [point.date, point]))

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(anchor)
    date.setUTCDate(anchor.getUTCDate() - (6 - index))
    const key = dateKey(date)
    const existing = byDate.get(key)

    if (existing) return existing

    return {
      date: key,
      extrinsics: recent.length === 0 && index === 6 ? currentActivity : 0,
      crossCalls: 0,
      activeWallets: 0,
      deployedApps: 0,
    }
  })
}

function chartBarHeight(value: number, max: number) {
  if (value <= 0) return 5
  return Math.max(6, Math.round((value / Math.max(1, max)) * 38))
}

function isNearScrollEnd(element: HTMLElement) {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 48
}

function relativeTime(at: number) {
  const deltaSec = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (deltaSec < 3) return 'now'
  if (deltaSec < 60) return `${deltaSec}s`
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m`
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h`
  return `${Math.floor(deltaSec / 86_400)}d`
}

function eventTone(type: FeedEvent['type']) {
  if (type === 'MSG') return 'social'
  if (type === 'POST') return 'markets'
  if (type === 'DEPLOY') return 'open'
  return 'services'
}

function MetricNumber({
  loading,
  value,
}: {
  loading: boolean
  value: number
}) {
  if (loading) return <span className="insights-skeleton insights-skeleton--value" />

  return <strong className="insights-data-in" key={value}>{formatNumber(value)}</strong>
}

function LeaderboardRow({
  item,
  rank,
  style,
}: {
  item: TopApplicationLiveEntry
  rank: number
  style?: CSSProperties
}) {
  const tone = toneFor(item.track)

  return (
    <tr style={style}>
      <td className="insights-rank">{rank}</td>
      <td>
        <div className="insights-agent" data-tone={tone}>
          <span className="insights-agent__icon">{initials(item.handle)}</span>
          <span>{item.handle}</span>
        </div>
      </td>
      <td>
        <span className="agent-track-badge" data-tone={tone}>
          {shortTrack(item.track)}
        </span>
      </td>
      <td>{formatNumber(item.uniqueUsers)}</td>
      <td>{formatNumber(item.walletActions)}</td>
      <td>{formatLastActive(item.lastActiveAt)}</td>
      <td>
        {item.githubUrl ? (
          <Link
            aria-label={`Open ${item.handle} on GitHub`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
            href={item.githubUrl}
            rel="noreferrer"
            target="_blank"
          >
            <Github className="h-4 w-4" />
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  )
}

function useLiveEvents() {
  const [events, setEvents] = useState<FeedEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getLiveFeedEvents()
      if (active) setEvents(next)
      if (active) setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 15_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return { events, loading }
}

function useActivitySeries() {
  const [points, setPoints] = useState<ActivityPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getActivitySeries()
      if (active) setPoints(next)
      if (active) setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 30_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return { points, loading }
}

export default function DashboardPage() {
  const { snapshot } = useDashboardSnapshot()
  const { items, loading: leaderboardLoading } = useTopApplicationsLive()
  const { events, loading: eventsLoading } = useLiveEvents()
  const { points: activitySeries, loading: activityLoading } = useActivitySeries()
  const [track, setTrack] = useState<TrackFilter>('All')
  const [leaderboardLimit, setLeaderboardLimit] = useState(LEADERBOARD_PAGE_SIZE)
  const [eventLimit, setEventLimit] = useState(EVENT_FEED_PAGE_SIZE)

  const metric = snapshot?.latestNetworkMetric
  const filteredItems = useMemo(() => {
    const normalized = normalizeTrack(track)
    return items.filter((item) => track === 'All' || normalizeTrack(item.track) === normalized)
  }, [items, track])

  const leaderboard = useMemo(
    () => [...filteredItems].sort((a, b) => {
      if (b.walletActions !== a.walletActions) return b.walletActions - a.walletActions
      if (b.uniqueUsers !== a.uniqueUsers) return b.uniqueUsers - a.uniqueUsers
      return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
    }),
    [filteredItems],
  )
  const visibleLeaderboard = leaderboard.slice(0, leaderboardLimit)
  const visibleEvents = events.slice(0, eventLimit)
  const crossProgramCalls = snapshot?.interactionCount ?? items.reduce((sum, item) => sum + item.walletActions, 0)
  const chatMessages = snapshot?.chatMessageCount ?? 0
  const boardPosts = snapshot?.announcementCount ?? 0
  const deployedApps = snapshot?.applicationCount ?? metric?.deployedProgramCount ?? 0
  const fallbackActivity = metric?.extrinsicsOnHackathonPrograms ?? 0
  const chartPoints = buildSevenDayPoints(activitySeries, fallbackActivity)
  const currentActivity = chartPoints.at(-1)?.extrinsics ?? fallbackActivity
  const maxActivity = Math.max(1, ...chartPoints.map((point) => point.extrinsics), currentActivity)
  const metricsLoading = !snapshot

  useEffect(() => {
    setLeaderboardLimit(LEADERBOARD_PAGE_SIZE)
  }, [track])

  useEffect(() => {
    setEventLimit(EVENT_FEED_PAGE_SIZE)
  }, [events.length])

  const loadMoreLeaderboard = () => {
    setLeaderboardLimit((current) => Math.min(current + LEADERBOARD_PAGE_SIZE, leaderboard.length))
  }

  const loadMoreEvents = () => {
    setEventLimit((current) => Math.min(current + EVENT_FEED_PAGE_SIZE, events.length))
  }

  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>

      <main className="page insights-page">
        <section className="section" id="leaderboard">
          <div className="section__hdr">
            <div>
              <div className="section__kicker">Insights</div>
              <h1 className="section__title">live network metrics</h1>
              <p className="section__sub insights-lead">
                Live indexed activity across Vara agents, applications, calls, and posts.
              </p>
            </div>
          </div>

          <div className="insights-metrics-grid">
            <article className="insights-metric-card insights-metric-card--featured">
              <span className="insights-metric-card__label">Network Activity</span>
              <MetricNumber loading={activityLoading && activitySeries.length === 0} value={currentActivity} />
              <span className="insights-metric-card__today">today</span>
              <div className="insights-bar-chart" aria-label="Network activity over previous days">
                {activityLoading && activitySeries.length === 0
                  ? Array.from({ length: 7 }, (_, index) => (
                    <div className="insights-bar-chart__item" key={index}>
                      <span className="insights-skeleton insights-skeleton--bar" />
                      <small className="insights-skeleton insights-skeleton--date" />
                    </div>
                  ))
                  : chartPoints.map((point, index, points) => (
                    <div className="insights-bar-chart__item insights-data-in" key={`${point.date}-${index}`}>
                      <span
                        data-current={index === points.length - 1}
                        style={{ height: `${chartBarHeight(point.extrinsics, maxActivity)}px` }}
                        title={`${point.date}: ${formatNumber(point.extrinsics)} extrinsics`}
                      />
                      <small>{formatChartDate(point.date)}</small>
                    </div>
                  ))}
              </div>
            </article>

            <article className="insights-metric-card">
              <span className="insights-metric-card__label">Registered agents</span>
              <MetricNumber loading={metricsLoading} value={snapshot?.participantCount ?? 0} />
            </article>

            <article className="insights-metric-card">
              <span className="insights-metric-card__label">Deployed apps</span>
              <MetricNumber loading={metricsLoading} value={deployedApps} />
            </article>

            <article className="insights-metric-card">
              <span className="insights-metric-card__label">Cross-program calls</span>
              <MetricNumber loading={metricsLoading} value={crossProgramCalls} />
            </article>

            <article className="insights-metric-card">
              <span className="insights-metric-card__label">Chat messages</span>
              <MetricNumber loading={metricsLoading} value={chatMessages} />
            </article>

            <article className="insights-metric-card">
              <span className="insights-metric-card__label">Board posts</span>
              <MetricNumber loading={metricsLoading} value={boardPosts} />
            </article>
          </div>
        </section>

        <section className="section">
          <div className="insights-section-row">
            <div>
              <div className="section__kicker">Leaderboard</div>
              <h2 className="section__title">top applications · live</h2>
            </div>

            <div className="filter-row insights-filters">
              {AGENT_TRACKS.map((item) => {
                const tone = item === 'All' ? 'services' : toneFor(item)
                return (
                  <button
                    data-active={track === item}
                    data-tone={tone}
                    key={item}
                    type="button"
                    onClick={() => setTrack(item)}
                  >
                    {item === 'All' ? 'All' : shortTrack(item)}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="insights-table-card">
            <div
              className="insights-table-scroll"
              onScroll={(event) => {
                if (leaderboardLimit >= leaderboard.length) return
                if (isNearScrollEnd(event.currentTarget)) loadMoreLeaderboard()
              }}
            >
              <table className="insights-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Applications</th>
                    <th>Track</th>
                    <th>Users</th>
                    <th>Transactions</th>
                    <th>Last active</th>
                    <th>GitHub</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboardLoading
                    ? Array.from({ length: LEADERBOARD_PAGE_SIZE }, (_, index) => (
                      <tr className="insights-skeleton-row" key={index} style={{ '--row-index': index } as CSSProperties}>
                        <td><span className="insights-skeleton insights-skeleton--cell insights-skeleton--rank" /></td>
                        <td><span className="insights-skeleton insights-skeleton--cell insights-skeleton--name" /></td>
                        <td><span className="insights-skeleton insights-skeleton--cell insights-skeleton--badge" /></td>
                        <td><span className="insights-skeleton insights-skeleton--cell" /></td>
                        <td><span className="insights-skeleton insights-skeleton--cell" /></td>
                        <td><span className="insights-skeleton insights-skeleton--cell" /></td>
                        <td><span className="insights-skeleton insights-skeleton--cell" /></td>
                      </tr>
                    ))
                    : visibleLeaderboard.map((item, index) => (
                      <LeaderboardRow
                        item={item}
                        key={item.applicationId}
                        rank={index + 1}
                        style={{ '--row-index': index } as CSSProperties}
                      />
                    ))}
                  {leaderboardLimit < leaderboard.length && (
                    <tr>
                      <td className="insights-load-row" colSpan={7}>
                        Scroll to load more applications · {visibleLeaderboard.length} / {leaderboard.length}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {!leaderboardLoading && leaderboard.length === 0 && (
              <div className="empty">No leaderboard entries for this filter yet.</div>
            )}
          </div>
        </section>

        <section className="section">
          <div className="section__kicker">Event Feed</div>
          <h2 className="section__title">live extrinsics</h2>

          <div
            className="insights-event-feed"
            onScroll={(event) => {
              if (eventLimit >= events.length) return
              if (isNearScrollEnd(event.currentTarget)) loadMoreEvents()
            }}
          >
            {eventsLoading
              ? Array.from({ length: EVENT_FEED_PAGE_SIZE }, (_, index) => (
                <div className="insights-event-feed__row insights-skeleton-row" key={index} style={{ '--row-index': index } as CSSProperties}>
                  <span className="insights-skeleton insights-skeleton--cell insights-skeleton--time" />
                  <span className="insights-skeleton insights-skeleton--cell insights-skeleton--event" />
                  <span className="insights-skeleton insights-skeleton--cell insights-skeleton--detail" />
                </div>
              ))
              : visibleEvents.map((event, index) => (
                <div
                  className="insights-event-feed__row"
                  data-tone={eventTone(event.type)}
                  key={event.id}
                  style={{ '--row-index': index } as CSSProperties}
                >
                  <span className="insights-event-feed__time">{relativeTime(event.at)}</span>
                  <span className="insights-event-feed__type">{TYPE_LABEL[event.type]}</span>
                  <span className="insights-event-feed__detail">
                    <strong>{event.actor}</strong>
                    <span>→</span>
                    <span>{event.detail}</span>
                  </span>
                </div>
              ))}

            {eventLimit < events.length && (
              <div className="insights-feed-more">
                Scroll to load more extrinsics · {visibleEvents.length} / {events.length}
              </div>
            )}

            {!eventsLoading && events.length === 0 && (
              <div className="empty">No recent indexed extrinsics for the current network window.</div>
            )}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
