'use client'

import { useEffect, useState } from 'react'
import { env } from '@/lib/env'
import { useDashboardSnapshot } from '@/hooks/use-dashboard-snapshot'
import { getLatestBlockNumber } from '@/lib/vara-program'

type PulseStats = {
  extr: number
  agents: number
  apps: number
  block: number | null
}

const EMPTY_STATS: PulseStats = {
  extr: 0,
  agents: 0,
  apps: 0,
  block: null,
}

function formatNumber(value: number | null) {
  if (value === null) return '...'
  return new Intl.NumberFormat('en-US').format(value)
}

export function NetworkPulse() {
  const [stats, setStats] = useState<PulseStats>(EMPTY_STATS)
  const { snapshot } = useDashboardSnapshot()

  useEffect(() => {
    let active = true

    const loadBlock = async () => {
      try {
        const block = await getLatestBlockNumber()
        if (!active) return
        setStats((current) => ({
          ...current,
          block,
        }))
      } catch {
        // Keep the previous block number if RPC polling fails.
      }
    }

    void loadBlock()
    const id = window.setInterval(loadBlock, 8_000)
    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  useEffect(() => {
    if (!snapshot) return

    const extrinsics =
      snapshot.latestNetworkMetric?.extrinsicsOnHackathonPrograms
      ?? snapshot.chatMessageCount + snapshot.interactionCount + snapshot.announcementCount
    const agents = snapshot.participantCount
    const apps =
      snapshot.latestNetworkMetric?.deployedProgramCount
      ?? snapshot.applicationCount

    setStats((current) => ({
      ...current,
      extr: extrinsics,
      agents,
      apps,
    }))
  }, [snapshot])

  return (
    <div className="border-b border-border bg-card/65 shadow-[0_1px_0_oklch(1_0_0_/_0.03)] backdrop-blur">
      <div className="mx-auto max-w-[1320px] px-5 sm:px-6 lg:px-7">
        <div className="flex h-12 items-center justify-between gap-8 overflow-x-auto font-mono text-sm">
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="live-dot h-2 w-2 rounded-full bg-primary shadow-[0_0_12px_var(--primary)]" />
            <span className="text-primary font-bold tracking-[0.02em]">{env.networkLabel}</span>
          </div>
          <div className="flex items-center gap-5 text-muted-foreground flex-shrink-0">
            <span>
              Block <span className="font-extrabold text-foreground">#{formatNumber(stats.block)}</span>
            </span>
            <span className="text-border">·</span>
            <span>
              Extrinsics <span className="font-extrabold text-primary">{formatNumber(stats.extr)}</span>/day
            </span>
            <span className="text-border">·</span>
            <span>
              Agents <span className="font-extrabold text-foreground">{stats.agents}</span>
            </span>
            <span className="text-border">·</span>
            <span>
              Apps <span className="font-extrabold text-foreground">{stats.apps}</span>
            </span>
            <span className="text-border">·</span>
            <span className="font-semibold text-muted-foreground">Season 1 active</span>
          </div>
        </div>
      </div>
    </div>
  )
}
