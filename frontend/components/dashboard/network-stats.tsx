'use client'

import { useEffect, useState } from 'react'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { useDashboardSnapshot } from '@/hooks/use-dashboard-snapshot'
import { DASHBOARD_STATS, type DashboardStat } from '@/lib/site-data'

function useAnimatedValue(target: number) {
  const [val, setVal] = useState(target * 0.8)
  useEffect(() => {
    const diff = target - val
    const step = diff / 20
    let current = val
    const id = setInterval(() => {
      current += step
      if (Math.abs(target - current) < 1) {
        setVal(target)
        clearInterval(id)
      } else {
        setVal(Math.round(current))
      }
    }, 30)
    return () => clearInterval(id)
  }, [target])
  return val
}

function StatCard({ stat }: { stat: DashboardStat }) {
  const Icon = stat.icon
  const animated = useAnimatedValue(stat.value)
  const positive = stat.trend >= 0

  return (
    <div className={`rounded-2xl border ${stat.border} ${stat.bg} p-5 hover:scale-[1.02] transition-all duration-300`}>
      <div className="flex items-start justify-between mb-4">
        <div className={`h-10 w-10 rounded-xl border ${stat.border} ${stat.bg} flex items-center justify-center`}>
          <Icon className={`h-5 w-5 ${stat.color}`} />
        </div>
        <div className={`flex items-center gap-1 text-xs font-mono font-medium ${positive ? 'text-primary' : 'text-destructive-foreground'}`}>
          {positive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {positive ? '+' : ''}{stat.trend}%
        </div>
      </div>
      <div className={`font-mono text-3xl font-bold ${stat.color} mb-1`}>
        {animated.toLocaleString()}{stat.unit}
      </div>
      <div className="text-xs text-muted-foreground">{stat.label}</div>
    </div>
  )
}

export function NetworkStats() {
  const { snapshot } = useDashboardSnapshot()
  const stats = DASHBOARD_STATS.map((stat) => {
    if (!snapshot) return stat

    if (stat.label === 'Extrinsics / Day') {
      return {
        ...stat,
        value:
          snapshot.latestNetworkMetric?.extrinsicsOnHackathonPrograms
          ?? snapshot.chatMessageCount + snapshot.interactionCount + snapshot.announcementCount
          ?? stat.value,
      }
    }

    if (stat.label === 'Active Wallets') {
      return {
        ...stat,
        value: snapshot.latestNetworkMetric?.uniqueWalletsCalling ?? stat.value,
      }
    }

    if (stat.label === 'Registered Apps') {
      return {
        ...stat,
        value: snapshot.applicationCount || stat.value,
      }
    }

    if (stat.label === 'Cross-Program Calls') {
      return {
        ...stat,
        value: snapshot.interactionCount || stat.value,
      }
    }

    if (stat.label === 'Integration Density') {
      const pct = snapshot.latestNetworkMetric?.crossProgramCallPct
      return {
        ...stat,
        value: pct != null ? Math.round(pct) : stat.value,
      }
    }

    return stat
  })

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {stats.map((s) => <StatCard key={s.label} stat={s} />)}
    </div>
  )
}
