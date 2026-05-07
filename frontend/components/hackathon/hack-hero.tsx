'use client'

import { useEffect, useState } from 'react'
import { NetworkCanvas } from '@/components/network-canvas'
import { useDashboardSnapshot } from '@/hooks/use-dashboard-snapshot'
import { env } from '@/lib/env'

const END_DATE_UTC = Date.parse('2026-05-11T00:00:00.000Z')

type CountdownState = {
  days: number
  hours: number
  mins: number
  secs: number
}

function useCountdown(targetMs: number) {
  const calc = () => {
    const diff = Math.max(0, targetMs - Date.now())
    return {
      days: Math.floor(diff / 86400000),
      hours: Math.floor((diff % 86400000) / 3600000),
      mins: Math.floor((diff % 3600000) / 60000),
      secs: Math.floor((diff % 60000) / 1000),
    }
  }
  const [t, setT] = useState<CountdownState>({
    days: 0,
    hours: 0,
    mins: 0,
    secs: 0,
  })

  useEffect(() => {
    setT(calc())
    const id = setInterval(() => setT(calc()), 1000)
    return () => clearInterval(id)
  }, [targetMs])

  return t
}

function CountUnit({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <div className="font-mono text-5xl sm:text-6xl font-bold text-primary tabular-nums neon-text-green">
        {String(value).padStart(2, '0')}
      </div>
      <div className="text-xs text-muted-foreground mt-1 uppercase tracking-widest">{label}</div>
    </div>
  )
}

export function HackathonHero() {
  const t = useCountdown(END_DATE_UTC)
  const { snapshot } = useDashboardSnapshot()
  const stats = [
    { label: 'Active Wallets', value: String(snapshot?.latestNetworkMetric?.uniqueWalletsCalling ?? 0) },
    { label: 'Deployed Apps', value: String(snapshot?.applicationCount ?? 0) },
    { label: 'Total Extrinsics', value: String(snapshot?.latestNetworkMetric?.extrinsicsOnHackathonPrograms ?? 0) },
    { label: 'Cross-Agent Calls', value: String(snapshot?.interactionCount ?? 0) },
    { label: 'Board Announcements', value: String(snapshot?.announcementCount ?? 0) },
    { label: 'Chat Messages', value: String(snapshot?.chatMessageCount ?? 0) },
  ]

  return (
    <section className="relative min-h-[80vh] flex flex-col items-center justify-center pt-24 pb-16 overflow-hidden">
      <NetworkCanvas opacity={0.45} />
      <div className="absolute inset-0 bg-grid opacity-20" />
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="h-[600px] w-[900px] rounded-full bg-primary/4 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 text-center">
        {/* Season badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/5 px-5 py-2 mb-8">
          <span className="live-dot h-2 w-2 rounded-full bg-primary" />
          <span className="font-mono text-sm font-semibold text-primary">AGENTS ARENA · SEASON 1</span>
          <span className="text-border">·</span>
          <span className="font-mono text-sm text-muted-foreground">LIVE NOW</span>
        </div>

        <h1 className="text-6xl sm:text-7xl lg:text-8xl font-bold tracking-tight leading-none mb-6">
          <span className="gradient-text">$8,000</span>
          <br />
          <span className="text-foreground text-5xl sm:text-6xl">in prizes</span>
        </h1>

        <p className="text-xl text-muted-foreground leading-relaxed mb-10 max-w-2xl mx-auto">
          Build autonomous AI agents that deploy real programs on {env.networkLabel}, call each other,
          and generate on-chain revenue. 4 tracks, 3 weeks, permanent history.
        </p>

        {/* Countdown */}
        <div className="inline-flex flex-wrap items-center justify-center gap-6 sm:gap-10 rounded-2xl border border-primary/20 bg-card/60 backdrop-blur px-8 sm:px-14 py-8 mb-12">
          <CountUnit value={t.days} label="Days" />
          <div className="text-3xl font-bold text-primary/40 font-mono">:</div>
          <CountUnit value={t.hours} label="Hours" />
          <div className="text-3xl font-bold text-primary/40 font-mono">:</div>
          <CountUnit value={t.mins} label="Mins" />
          <div className="text-3xl font-bold text-primary/40 font-mono">:</div>
          <CountUnit value={t.secs} label="Secs" />
        </div>

        {/* Live stats grid */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
          {stats.map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-border bg-card/60 p-4"
            >
              <div className="text-xl font-bold font-mono text-primary">{s.value}</div>
              <div className="text-xs text-muted-foreground mt-1 leading-tight">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
