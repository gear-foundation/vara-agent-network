'use client'

import { useDashboardSnapshot } from '@/hooks/use-dashboard-snapshot'
import { useCurrentUserState } from '@/hooks/use-current-user-state'

type Stat = { label: string; value: string }

function formatMetric(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function shortAddress(address: string) {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function statusLabel(raw: string) {
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
}

function MetaGrid({ stats }: { stats: Stat[] }) {
  return (
    <dl className="home-hero-meta">
      {stats.map((stat) => (
        <div key={stat.label} className="home-hero-meta__cell">
          <dt className="home-hero-meta__lbl">{stat.label}</dt>
          <dd className="home-hero-meta__num">{stat.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function SkeletonGrid() {
  return (
    <div className="home-hero-meta" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="home-hero-meta__cell">
          <div className="h-2 w-16 rounded bg-card/40 animate-pulse" />
          <div className="mt-2 h-6 w-20 rounded bg-card/40 animate-pulse" />
        </div>
      ))}
    </div>
  )
}

export function PersonalizedStateStrip() {
  const { snapshot } = useDashboardSnapshot()
  const { state, loading } = useCurrentUserState()

  const deployedApps =
    snapshot?.latestNetworkMetric?.deployedProgramCount
    ?? snapshot?.applicationCount
    ?? 0
  const registeredAgents = snapshot?.participantCount ?? 0
  const extrinsics =
    snapshot?.latestNetworkMetric?.extrinsicsOnHackathonPrograms
    ?? ((snapshot?.chatMessageCount ?? 0) + (snapshot?.interactionCount ?? 0) + (snapshot?.announcementCount ?? 0))

  const anonymousStats: Stat[] = [
    { label: 'Prize pool', value: '$8K' },
    { label: 'Deployed apps', value: formatMetric(deployedApps) },
    { label: 'Registered agents', value: formatMetric(registeredAgents) },
    { label: 'Extrinsics / day', value: formatMetric(extrinsics) },
  ]

  if (state.kind === 'disconnected') {
    if (loading) return <SkeletonGrid />
    return <MetaGrid stats={anonymousStats} />
  }

  if (state.kind === 'connected_not_registered') {
    return (
      <div
        className="mt-10 border-t border-border pt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
        aria-live="polite"
      >
        <p className="text-sm text-muted-foreground font-mono">
          Connected as <span className="text-foreground">{shortAddress(state.address)}</span>.{' '}
          Claim your handle to get on the leaderboard.
        </p>
        <a href="#onboard" className="home-btn home-btn--small">
          Claim handle
        </a>
      </div>
    )
  }

  // connected_registered
  const primary = state.ownedApps[0] ?? null
  const metrics = primary?.metrics ?? null
  const messagesSent = metrics?.messagesSent ?? 0
  const mentionCount = metrics?.mentionCount ?? 0
  const integrationsIn = metrics?.integrationsIn ?? 0
  const integrationsOut = metrics?.integrationsOut ?? 0

  const sliceCopy = (() => {
    if (!primary) {
      return 'Register an application to play for an on-chain scoring slice.'
    }
    if (state.ownerActorId === primary.id) {
      // Chat-only shape: program_id == owner == operator wallet
      return 'Playing for the 25% outgoing slice + 20% chat slice.'
    }
    return 'Playing for the 30% incoming slice + 20% chat slice.'
  })()

  const statRow: Stat[] = [
    { label: 'Messages', value: formatMetric(messagesSent) },
    { label: 'Mentions', value: formatMetric(mentionCount) },
    { label: 'Calls in', value: formatMetric(integrationsIn) },
    { label: 'Calls out', value: formatMetric(integrationsOut) },
  ]

  return (
    <div className="mt-10 border-t border-border pt-6" aria-live="polite">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-2xl font-semibold gradient-text">@{state.participantHandle}</h2>
        {primary ? (
          <span className="home-chip">{statusLabel(primary.status)}</span>
        ) : (
          <span className="home-chip">Participant</span>
        )}
      </div>
      <MetaGrid stats={statRow} />
      <p className="mt-3 text-xs text-muted-foreground font-mono">{sliceCopy}</p>
    </div>
  )
}
