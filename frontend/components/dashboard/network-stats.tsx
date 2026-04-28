'use client'

import { useEffect, useState } from 'react'
import { Activity, GitBranch, MessageSquare, Pin, Users, Zap } from 'lucide-react'
import { useDashboardSnapshot } from '@/hooks/use-dashboard-snapshot'
import type { DashboardStat } from '@/lib/site-data'

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

  return (
    <div className={`rounded-2xl border ${stat.border} ${stat.bg} p-5 hover:scale-[1.02] transition-all duration-300`}>
      <div className="flex items-start justify-between mb-4">
        <div className={`h-10 w-10 rounded-xl border ${stat.border} ${stat.bg} flex items-center justify-center`}>
          <Icon className={`h-5 w-5 ${stat.color}`} />
        </div>
        <div className="rounded-full border border-border/70 bg-background/50 px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
          Live
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
  const stats: DashboardStat[] = [
    {
      label: 'Extrinsics / Day',
      value: snapshot?.latestNetworkMetric?.extrinsicsOnHackathonPrograms ?? 0,
      unit: '',
      icon: Activity,
      trend: 0,
      color: 'text-primary',
      bg: 'bg-primary/10',
      border: 'border-primary/20',
    },
    {
      label: 'Active Wallets',
      value: snapshot?.latestNetworkMetric?.uniqueWalletsCalling ?? 0,
      unit: '',
      icon: Users,
      trend: 0,
      color: 'text-accent',
      bg: 'bg-accent/10',
      border: 'border-accent/20',
    },
    {
      label: 'Deployed Apps',
      value: snapshot?.applicationCount ?? 0,
      unit: '',
      icon: Zap,
      trend: 0,
      color: 'text-yellow-400',
      bg: 'bg-yellow-400/10',
      border: 'border-yellow-400/20',
    },
    {
      label: 'Chat Messages',
      value: snapshot?.chatMessageCount ?? 0,
      unit: '',
      icon: MessageSquare,
      trend: 0,
      color: 'text-pink-400',
      bg: 'bg-pink-400/10',
      border: 'border-pink-400/20',
    },
    {
      label: 'Cross-Program Calls',
      value: snapshot?.interactionCount ?? 0,
      unit: '',
      icon: GitBranch,
      trend: 0,
      color: 'text-blue-400',
      bg: 'bg-blue-400/10',
      border: 'border-blue-400/20',
    },
    {
      label: 'Board Posts',
      value: snapshot?.announcementCount ?? 0,
      unit: '',
      icon: Pin,
      trend: 0,
      color: 'text-primary',
      bg: 'bg-primary/10',
      border: 'border-primary/20',
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {stats.map((s) => <StatCard key={s.label} stat={s} />)}
    </div>
  )
}
