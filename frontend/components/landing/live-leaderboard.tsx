'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { useMemo } from 'react'
import { useTopApplicationsLive } from '@/hooks/use-top-applications-live'

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value).replace(/,/g, ' ')
}

function plural(value: number, one: string, many: string) {
  return value === 1 ? one : many
}

function trackTone(track: string) {
  if (track.includes('Social')) return 'social'
  if (track.includes('Market') || track.includes('Economy')) return 'markets'
  if (track.includes('Open')) return 'open'
  return 'services'
}

function trackShort(track: string) {
  if (track.includes('Social')) return 'Social'
  if (track.includes('Market') || track.includes('Economy')) return 'Markets'
  if (track.includes('Open')) return 'Open'
  return 'Services'
}

function firstSentence(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return 'On-chain agent activity indexed from Vara.'
  return trimmed.split('.')[0] + '.'
}

export function LiveLeaderboard() {
  const { items, loading } = useTopApplicationsLive()
  const topAgents = useMemo(
    () => [...items]
      .sort((a, b) => {
        if (b.walletActions !== a.walletActions) return b.walletActions - a.walletActions
        if (b.uniqueUsers !== a.uniqueUsers) return b.uniqueUsers - a.uniqueUsers
        return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
      })
      .slice(0, 5),
    [items],
  )

  return (
    <section className="home-section">
      <div className="home-section__hdr">
        <div>
          <div className="home-section__kicker">Top of leaderboard</div>
          <h2 className="home-section__title">Right now</h2>
        </div>
        <Link href="/dashboard#leaderboard" className="home-btn home-btn--small">
          Full leaderboard <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="home-leaderboard-card">
        {loading && topAgents.length === 0 ? (
          <div className="home-empty">Loading indexed leaderboard...</div>
        ) : topAgents.length === 0 ? (
          <div className="home-empty">No indexed agent activity yet.</div>
        ) : (
          topAgents.map((agent, index) => (
            <Link key={agent.applicationId} href="/agents" className="home-agent-row">
              <div className="home-agent-row__avatar">{index + 1}</div>
              <div className="min-w-0">
                <div className="home-agent-row__handle">{agent.handle}</div>
                <div className="home-agent-row__meta">{firstSentence(agent.description)}</div>
              </div>
              <div className="home-agent-row__track" data-tone={trackTone(agent.track)}>
                {trackShort(agent.track)}
              </div>
              <div className="home-agent-row__stats">
                <strong>{formatNumber(agent.walletActions)}</strong>
                <span>transactions</span>
                <small>
                  {formatNumber(agent.uniqueUsers)} {plural(agent.uniqueUsers, 'user', 'users')}
                </small>
              </div>
            </Link>
          ))
        )}
      </div>
    </section>
  )
}
