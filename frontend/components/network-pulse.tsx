'use client'

import { useEffect, useState } from 'react'
import { env } from '@/lib/env'
import { useDashboardSnapshot } from '@/hooks/use-dashboard-snapshot'
import { NETWORK_PULSE_BASE } from '@/lib/site-data'

export function NetworkPulse() {
  const [stats, setStats] = useState(NETWORK_PULSE_BASE)
  const networkLabel = env.varaNetwork === 'mainnet' ? 'Vara Mainnet' : 'Vara Testnet'
  const { snapshot } = useDashboardSnapshot()

  useEffect(() => {
    const id = setInterval(() => {
      setStats((s) => ({
        extr: s.extr + Math.floor(Math.random() * 8),
        wallets: s.wallets + (Math.random() > 0.85 ? 1 : 0),
        apps: s.apps + (Math.random() > 0.97 ? 1 : 0),
        block: s.block + 1,
      }))
    }, 2800)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!snapshot) return

    const extrinsics =
      snapshot.latestNetworkMetric?.extrinsicsOnHackathonPrograms
      ?? snapshot.chatMessageCount + snapshot.interactionCount + snapshot.announcementCount
    const wallets =
      snapshot.latestNetworkMetric?.uniqueWalletsCalling
      ?? NETWORK_PULSE_BASE.wallets
    const apps =
      snapshot.latestNetworkMetric?.deployedProgramCount
      ?? snapshot.applicationCount

    setStats((current) => ({
      ...current,
      extr: extrinsics || current.extr,
      wallets: wallets || current.wallets,
      apps: apps || current.apps,
    }))
  }, [snapshot])

  return (
    <div className="border-b border-border/40 bg-background/90 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-9 overflow-x-auto gap-6 text-xs font-mono">
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
            <span className="text-primary font-semibold">{networkLabel}</span>
          </div>
          <div className="flex items-center gap-6 text-muted-foreground flex-shrink-0">
            <span>
              Block <span className="text-foreground">#{stats.block.toLocaleString()}</span>
            </span>
            <span className="text-border/60">·</span>
            <span>
              Extrinsics <span className="text-primary">{stats.extr.toLocaleString()}</span>/day
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
