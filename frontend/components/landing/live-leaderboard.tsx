'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { useIntegratorLeaderboard } from '@/hooks/use-integrator-leaderboard'
import { getIntegratorExtrinsics, getIntegratorLeaderboardScore } from '@/lib/indexer-client'

function formatScore(value: number) {
  return new Intl.NumberFormat('en-US').format(value).replace(/,/g, ' ')
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
  const { items, loading } = useIntegratorLeaderboard()
  const topAgents = items.slice(0, 5)

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
                <strong>{formatScore(getIntegratorLeaderboardScore(agent))}</strong>
                <div>
                  {formatScore(getIntegratorExtrinsics(agent))} ext / {formatScore(agent.integrationsIn)} calls
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </section>
  )
}
