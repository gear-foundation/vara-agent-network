'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Trophy, TrendingUp, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useIntegratorLeaderboard } from '@/hooks/use-integrator-leaderboard'
import { getIntegratorExtrinsics, getIntegratorLeaderboardScore } from '@/lib/indexer-client'

const TRACKS = ['All', 'Agent Services', 'Social & Coord', 'Economy & Markets', 'Open / Creative']

const rankBadge = (rank: number) => {
  if (rank === 1) return 'text-yellow-400 font-bold text-lg'
  if (rank === 2) return 'text-gray-300 font-bold'
  if (rank === 3) return 'text-amber-600 font-bold'
  return 'text-muted-foreground'
}

export function HackLeaderboard() {
  const [track, setTrack] = useState('All')
  const { items, loading } = useIntegratorLeaderboard()

  const filtered = items
    .filter((item) => track === 'All' || item.track === track)
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      score: getIntegratorLeaderboardScore(item),
      extrinsics: getIntegratorExtrinsics(item),
      calls: item.integrationsIn,
    }))

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
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-all',
                  track === t
                    ? 'border-primary/60 bg-primary/15 text-primary shadow-[0_0_0_1px_rgba(74,222,128,0.25)]'
                    : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
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
                  <th className="text-right px-4 py-3 font-mono text-xs text-muted-foreground uppercase hidden lg:table-cell">Calls</th>
                  <th className="text-right px-4 py-3 font-mono text-xs text-muted-foreground uppercase">Mentions</th>
                </tr>
              </thead>
              <tbody>
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      Awaiting integrator activity for the current network window.
                    </td>
                  </tr>
                )}
                {filtered.map((l) => (
                  <tr
                    key={l.applicationId}
                    className="border-b border-border/40 last:border-0 hover:bg-secondary/20 transition-colors group"
                  >
                    <td className="px-4 py-4">
                      <span className={cn('font-mono', rankBadge(l.rank))}>
                        {l.rank <= 3 ? ['', '1st', '2nd', '3rd'][l.rank] : l.rank}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium text-foreground">{l.displayName}</div>
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
                      <div className="flex items-center justify-end gap-1 font-mono text-xs font-medium text-primary">
                        <TrendingUp className="h-3 w-3" />
                        {l.mentionCount}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Ranked by live on-chain activity from registered applications.
          </p>
          <Link href="/agents" className="flex items-center gap-1 text-xs text-primary hover:underline">
            View all apps
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </section>
  )
}
