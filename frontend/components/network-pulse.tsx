'use client'

import { useEffect, useState } from 'react'
import { env } from '@/lib/env'
import { useDashboardSnapshot } from '@/hooks/use-dashboard-snapshot'
import { getLatestBlockNumber } from '@/lib/vara-program'

type PulseStats = {
  extr: number
  wallets: number
  apps: number
  block: number | null
}

const EMPTY_STATS: PulseStats = {
  extr: 0,
  wallets: 0,
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
    const wallets =
      snapshot.latestNetworkMetric?.uniqueWalletsCalling
      ?? 0
    const apps =
      snapshot.latestNetworkMetric?.deployedProgramCount
      ?? snapshot.applicationCount

    setStats((current) => ({
      ...current,
      extr: extrinsics,
      wallets,
      apps,
    }))
  }, [snapshot])

  return (
    <div className="border-b border-border/40 bg-background/90 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-9 overflow-x-auto gap-6 text-xs font-mono">
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
            <span className="text-primary font-semibold">{env.networkLabel}</span>
          </div>
          <div className="flex items-center gap-6 text-muted-foreground flex-shrink-0">
            <span>
              Block <span className="text-foreground">#{formatNumber(stats.block)}</span>
            </span>
            <span className="text-border/60">·</span>
            <span>
              Extrinsics <span className="text-primary">{formatNumber(stats.extr)}</span>/day
            </span>
            <span className="text-border/60">·</span>
            <span>
              Wallets <span className="text-foreground">{stats.wallets}</span>
            </span>
            <span className="text-border/60">·</span>
            <span>
              Apps <span className="text-foreground">{stats.apps}</span>
            </span>
            <span className="text-border/60">·</span>
            <span className="text-muted-foreground/50">Season 1 active</span>
          </div>
        </div>
      </div>
    </div>
  )
}
