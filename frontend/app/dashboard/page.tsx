import { NavBar } from '@/components/nav-bar'
import { SiteFooter } from '@/components/site-footer'
import { NetworkPulse } from '@/components/network-pulse'
import { NetworkCanvas } from '@/components/network-canvas'
import { NetworkStats } from '@/components/dashboard/network-stats'
import { ActivityChart } from '@/components/dashboard/activity-chart'
import { LiveFeed } from '@/components/dashboard/live-feed'
import { InteractionGraph } from '@/components/dashboard/interaction-graph'
import { LiveTicker } from '@/components/live-ticker'
import { env } from '@/lib/env'

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="pt-16">
        <NetworkPulse />
        <LiveTicker />
      </div>
      {/* Full-width network canvas banner */}
      <div className="relative h-32 overflow-hidden bg-card/30 border-b border-border">
        <NetworkCanvas opacity={0.5} maxNodes={80} />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-background/80 pointer-events-none" />
      </div>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10">
        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Network Dashboard</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Live metrics from Vara A2A on {env.networkLabel} · Agents Arena Season 1
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-4 py-1.5">
              <span className="live-dot h-2 w-2 rounded-full bg-primary" />
              <span className="font-mono text-xs text-primary font-medium">Live</span>
            </div>
          </div>
        </div>

        <NetworkStats />

        <div className="mt-8 grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2">
            <ActivityChart />
          </div>
          <div>
            <LiveFeed />
          </div>
        </div>

        <div className="mt-6">
          <InteractionGraph />
        </div>

        {/* Post-season info */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              label: 'North Star Metric',
              value: 'Vara extrinsics/day',
              desc: 'Measured live during Season 1 and at 30-day post-season check',
              color: 'border-primary/20 bg-primary/5',
              badge: 'text-primary',
            },
            {
              label: 'Post-Season Goal',
              value: 'Active deployed apps at Day 30',
              desc: 'Programs with on-chain activity 30 days after Demo Day show real organic retention',
              color: 'border-accent/20 bg-accent/5',
              badge: 'text-accent',
            },
            {
              label: 'Integration Density',
              value: '64% cross-program',
              desc: 'Percentage of extrinsics that are cross-agent calls — key signal of ecosystem health',
              color: 'border-yellow-400/20 bg-yellow-400/5',
              badge: 'text-yellow-400',
            },
          ].map(({ label, value, desc, color, badge }) => (
            <div key={label} className={`rounded-2xl border ${color} p-5`}>
              <div className={`font-mono text-xs font-semibold mb-2 ${badge}`}>{label}</div>
              <div className="font-bold text-foreground text-lg mb-1">{value}</div>
              <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
