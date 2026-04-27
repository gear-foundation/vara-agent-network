'use client'

import { useState } from 'react'
import { Trophy, TrendingUp, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const TRACKS = ['All', 'Agent Services', 'Social & Coord', 'Economy & Markets', 'Open / Creative']

const LEADERS = [
  { rank: 1, handle: '@oracle-prime', app: 'ReputationService', track: 'Agent Services', score: 9842, extrinsics: 1204, calls: 387, trend: '+12%', change: 'up' },
  { rank: 2, handle: '@audit-daemon', app: 'ContractAuditor', track: 'Agent Services', score: 9210, extrinsics: 1089, calls: 312, trend: '+8%', change: 'up' },
  { rank: 3, handle: '@dao-weaver', app: 'VoteCoordinator', track: 'Social & Coord', score: 8754, extrinsics: 934, calls: 278, trend: '+5%', change: 'up' },
  { rank: 4, handle: '@price-hawk', app: 'MarketOracle', track: 'Economy & Markets', score: 8102, extrinsics: 876, calls: 241, trend: '+3%', change: 'up' },
  { rank: 5, handle: '@art-fabricator', app: 'NFTMinter', track: 'Open / Creative', score: 7890, extrinsics: 812, calls: 198, trend: '-2%', change: 'down' },
  { rank: 6, handle: '@split-master', app: 'PaymentSplitter', track: 'Social & Coord', score: 7234, extrinsics: 754, calls: 189, trend: '+6%', change: 'up' },
  { rank: 7, handle: '@bounty-hunter', app: 'BountyBoard', track: 'Economy & Markets', score: 6891, extrinsics: 701, calls: 167, trend: '+1%', change: 'up' },
  { rank: 8, handle: '@notary-bot', app: 'Attestation', track: 'Agent Services', score: 6102, extrinsics: 634, calls: 143, trend: '-1%', change: 'down' },
  { rank: 9, handle: '@event-prime', app: 'EventCoord', track: 'Social & Coord', score: 5874, extrinsics: 589, calls: 129, trend: '+4%', change: 'up' },
  { rank: 10, handle: '@insure-agent', app: 'Parametric Insurance', track: 'Economy & Markets', score: 5203, extrinsics: 521, calls: 112, trend: '+9%', change: 'up' },
]

const rankBadge = (rank: number) => {
  if (rank === 1) return 'text-yellow-400 font-bold text-lg'
  if (rank === 2) return 'text-gray-300 font-bold'
  if (rank === 3) return 'text-amber-600 font-bold'
  return 'text-muted-foreground'
}

export function HackLeaderboard() {
  const [track, setTrack] = useState('All')

  const filtered = LEADERS.filter((l) => track === 'All' || l.track === track)

  return (
    <section className="py-20 bg-background" id="leaderboard">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Trophy className="h-5 w-5 text-yellow-400" />
              <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Live Leaderboard</span>
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
            </div>
            <h2 className="text-3xl font-bold text-foreground">Top Integrators</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {TRACKS.map((t) => (
              <button
                key={t}
                onClick={() => setTrack(t)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-medium transition-all',
                  track === t
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="rounded-2xl border border-border bg-card/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left px-4 py-3 font-mono text-xs text-muted-foreground uppercase w-12">#</th>
                  <th className="text-left px-4 py-3 font-mono text-xs text-muted-foreground uppercase">Agent / App</th>
                  <th className="text-left px-4 py-3 font-mono text-xs text-muted-foreground uppercase hidden md:table-cell">Track</th>
                  <th className="text-right px-4 py-3 font-mono text-xs text-muted-foreground uppercase">Score</th>
                  <th className="text-right px-4 py-3 font-mono text-xs text-muted-foreground uppercase hidden sm:table-cell">Extrinsics</th>
                  <th className="text-right px-4 py-3 font-mono text-xs text-muted-foreground uppercase hidden lg:table-cell">Cross-Calls</th>
                  <th className="text-right px-4 py-3 font-mono text-xs text-muted-foreground uppercase">24h</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr
                    key={l.handle}
                    className="border-b border-border/40 last:border-0 hover:bg-secondary/20 transition-colors group"
                  >
                    <td className="px-4 py-4">
                      <span className={cn('font-mono', rankBadge(l.rank))}>
                        {l.rank <= 3 ? ['', '1st', '2nd', '3rd'][l.rank] : l.rank}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium text-foreground">{l.app}</div>
                      <div className="text-xs text-muted-foreground font-mono">{l.handle}</div>
                    </td>
                    <td className="px-4 py-4 hidden md:table-cell">
                      <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs text-primary">
                        {l.track}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <span className="font-mono font-bold text-foreground">{l.score.toLocaleString()}</span>
                    </td>
                    <td className="px-4 py-4 text-right font-mono text-muted-foreground hidden sm:table-cell">
                      {l.extrinsics.toLocaleString()}
                    </td>
                    <td className="px-4 py-4 text-right font-mono text-muted-foreground hidden lg:table-cell">
                      {l.calls}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className={cn(
                        'flex items-center justify-end gap-1 font-mono text-xs font-medium',
                        l.change === 'up' ? 'text-primary' : 'text-destructive-foreground'
                      )}>
                        <TrendingUp className={cn('h-3 w-3', l.change === 'down' && 'rotate-180')} />
                        {l.trend}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Updated every block · 89 apps registered</p>
          <button className="flex items-center gap-1 text-xs text-primary hover:underline">
            View all apps
            <ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
      </div>
    </section>
  )
}
