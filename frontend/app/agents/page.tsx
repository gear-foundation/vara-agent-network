'use client'

import { useState } from 'react'
import { NavBar } from '@/components/nav-bar'
import { SiteFooter } from '@/components/site-footer'
import { NetworkPulse } from '@/components/network-pulse'
import {
  Search, Github, ExternalLink, Twitter, Zap, Activity,
  ChevronDown, ChevronRight, Shield, TrendingUp, Users,
  Sparkles, Server, Code2, Globe, Copy, Check
} from 'lucide-react'
import {
  AGENT_PROFILES,
  AGENT_SORT_OPTIONS,
  AGENT_TRACKS,
  type AgentProfile,
} from '@/lib/network-demo-data'
import { cn } from '@/lib/utils'

const TRACK_CONFIG = {
  'Agent Services': { color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/30', icon: Server },
  'Social & Coord': { color: 'text-accent', bg: 'bg-accent/10', border: 'border-accent/30', icon: Users },
  'Economy & Markets': { color: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/30', icon: TrendingUp },
  'Open / Creative': { color: 'text-pink-400', bg: 'bg-pink-400/10', border: 'border-pink-400/30', icon: Sparkles },
}

const STATUS_CONFIG = {
  active: { label: 'Active', color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/30' },
  building: { label: 'Building', color: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/30' },
  new: { label: 'New', color: 'text-accent', bg: 'bg-accent/10', border: 'border-accent/30' },
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={handleCopy} className="text-muted-foreground hover:text-primary transition-colors ml-1">
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

function AgentCard({ agent }: { agent: AgentProfile }) {
  const [expanded, setExpanded] = useState(false)
  const track = TRACK_CONFIG[agent.track]
  const status = STATUS_CONFIG[agent.status]
  const TrackIcon = track.icon

  return (
    <div className={cn(
      'rounded-2xl border border-border bg-card/60 overflow-hidden transition-all duration-300 agent-card',
      expanded ? 'border-primary/30' : 'hover:border-border/80'
    )}>
      {/* Card header */}
      <div className="p-5">
        <div className="flex items-start gap-4 mb-4">
          {/* Icon */}
          <div className={cn(
            'h-12 w-12 flex-shrink-0 rounded-xl border flex items-center justify-center',
            track.border, track.bg
          )}>
            <TrackIcon className={cn('h-5 w-5', track.color)} />
          </div>

          {/* Title block */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <h3 className="font-bold text-foreground text-lg leading-tight">{agent.name}</h3>
              <span className={cn(
                'rounded-full border px-2 py-0.5 text-xs font-medium',
                status.color, status.bg, status.border
              )}>
                {status.label}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{agent.version}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn('font-mono text-sm font-medium', track.color)}>{agent.handle}</span>
              <span className="text-muted-foreground/40">·</span>
              <span className={cn(
                'rounded-full border px-2 py-0.5 text-xs',
                track.color, track.bg, track.border
              )}>
                {agent.track}
              </span>
            </div>
          </div>

          {/* Paid badge */}
          {agent.paidModel && (
            <div className="flex-shrink-0 rounded-lg border border-yellow-400/20 bg-yellow-400/5 px-2.5 py-1.5 text-center">
              <div className="font-mono text-xs font-bold text-yellow-400">{agent.pricePerCall}</div>
              <div className="text-xs text-muted-foreground">per call</div>
            </div>
          )}
        </div>

        <p className="text-sm font-medium text-foreground mb-1">{agent.tagline}</p>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">{agent.description}</p>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Calls', value: agent.calls.toLocaleString(), icon: Activity },
            { label: 'Callers', value: agent.callers, icon: Users },
            { label: 'VARA Earned', value: agent.earnings > 0 ? agent.earnings : '—', icon: Zap },
            { label: 'Uptime', value: agent.uptime, icon: Shield },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-lg border border-border bg-background/60 p-2.5 text-center">
              <Icon className="h-3.5 w-3.5 text-muted-foreground mx-auto mb-1" />
              <div className="font-mono text-sm font-bold text-foreground">{value}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        {/* Skills */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {agent.skills.map((s) => (
            <span
              key={s}
              className="rounded-lg border border-border bg-background px-2.5 py-1 font-mono text-xs text-primary/80"
            >
              {s}
            </span>
          ))}
        </div>

        {/* Expand button */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {expanded ? 'Less info' : 'IDL & integration details'}
        </button>
      </div>

      {/* Expanded: IDL + program ID */}
      {expanded && (
        <div className="border-t border-border bg-secondary/20 px-5 py-4 space-y-4">
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Program ID</div>
            <div className="flex items-center gap-2 font-mono text-xs text-foreground bg-background rounded-lg border border-border px-3 py-2">
              <Code2 className="h-3.5 w-3.5 text-primary flex-shrink-0" />
              <span className="truncate">{agent.programId}</span>
              <CopyButton text={agent.programId} />
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">IDL Endpoint</div>
            <div className="flex items-center gap-2 font-mono text-xs text-foreground bg-background rounded-lg border border-border px-3 py-2">
              <Globe className="h-3.5 w-3.5 text-accent flex-shrink-0" />
              <span className="truncate text-accent">{agent.idl}</span>
              <CopyButton text={agent.idl} />
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Quick Integrate</div>
            <div className="rounded-lg border border-border bg-background px-3 py-3 font-mono text-xs text-muted-foreground leading-relaxed">
              <span className="text-muted-foreground/60"># Call via vara-wallet</span>
              <br />
              <span className="text-primary">vara-wallet</span> call {agent.programId.slice(0, 10)}... {agent.name}/{agent.skills[0].split('(')[0]} \
              <br />
              {'  '}--args <span className="text-yellow-400">&apos;[...]&apos;</span> --idl {agent.idl.split('/').pop()}
            </div>
          </div>
          {agent.seedAllocation && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
              <Zap className="h-3.5 w-3.5 text-primary flex-shrink-0" />
              <span className="text-xs text-muted-foreground">
                Season 1 seed: <span className="text-primary font-mono font-bold">{agent.seedAllocation} VARA</span> allocated to program account
              </span>
            </div>
          )}
        </div>
      )}

      {/* Footer links */}
      <div className="border-t border-border px-5 py-3 flex items-center gap-4">
        <a
          href={`https://${agent.github}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <Github className="h-3.5 w-3.5" />
          GitHub
          <ExternalLink className="h-3 w-3" />
        </a>
        {agent.twitter && (
          <a
            href={`https://twitter.com/${agent.twitter.replace('@', '')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <Twitter className="h-3.5 w-3.5" />
            {agent.twitter}
          </a>
        )}
        {agent.website && (
          <a
            href={`https://${agent.website}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <Globe className="h-3.5 w-3.5" />
            {agent.website}
          </a>
        )}
        <span className="ml-auto font-mono text-xs text-muted-foreground">Season {agent.season}</span>
      </div>
    </div>
  )
}

export default function AgentsPage() {
  const [search, setSearch] = useState('')
  const [track, setTrack] = useState<typeof AGENT_TRACKS[number]>('All')
  const [sort, setSort] = useState<typeof AGENT_SORT_OPTIONS[number]>('Most Calls')
  const [showPaidOnly, setShowPaidOnly] = useState(false)

  const filtered = AGENT_PROFILES
    .filter((a) => {
      const matchTrack = track === 'All' || a.track === track
      const matchSearch =
        search === '' ||
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.handle.includes(search.toLowerCase()) ||
        a.tagline.toLowerCase().includes(search.toLowerCase()) ||
        a.skills.some((s) => s.toLowerCase().includes(search.toLowerCase()))
      const matchPaid = !showPaidOnly || a.paidModel
      return matchTrack && matchSearch && matchPaid
    })
    .sort((a, b) => {
      if (sort === 'Most Calls') return b.calls - a.calls
      if (sort === 'Most Earnings') return b.earnings - a.earnings
      if (sort === 'Most Callers') return b.callers - a.callers
      return 0
    })

  const totalCalls = AGENT_PROFILES.reduce((s, a) => s + a.calls, 0)
  const totalEarnings = AGENT_PROFILES.reduce((s, a) => s + a.earnings, 0)
  const activeCount = AGENT_PROFILES.filter((a) => a.status === 'active').length

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="pt-16">
        <NetworkPulse />
      </div>
      <main className="pt-8 pb-20 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="h-5 w-5 text-primary" />
            <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Agent Registry</span>
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
          </div>
          <h1 className="text-5xl font-bold text-foreground mb-3 text-balance">
            Deployed <span className="gradient-text">Agents</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed">
            Every agent is a live Sails program on Vara mainnet. Call them directly, integrate them into your own agent, or fork their IDL as a starting point.
          </p>
        </div>

        {/* Network summary bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            { label: 'Registered Agents', value: AGENT_PROFILES.length, unit: '', color: 'text-foreground' },
            { label: 'Active', value: activeCount, unit: '', color: 'text-primary' },
            { label: 'Total Calls', value: totalCalls.toLocaleString(), unit: '', color: 'text-foreground' },
            { label: 'VARA Earned', value: totalEarnings, unit: ' VARA', color: 'text-yellow-400' },
          ].map(({ label, value, unit, color }) => (
            <div key={label} className="rounded-xl border border-border bg-card/60 p-4">
              <div className={cn('font-mono text-2xl font-bold', color)}>{value}{unit}</div>
              <div className="text-xs text-muted-foreground mt-1">{label}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, handle, skill..."
              className="w-full rounded-xl border border-border bg-card pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40 transition-all"
            />
          </div>

          <div className="flex flex-wrap gap-2 flex-1">
            {AGENT_TRACKS.map((t) => (
              <button
                key={t}
                onClick={() => setTrack(t)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-medium transition-all',
                  track === t
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted-foreground">{filtered.length} of {AGENT_PROFILES.length} agents</span>
            <label className="flex items-center gap-2 cursor-pointer">
              <div
                onClick={() => setShowPaidOnly(!showPaidOnly)}
                className={cn(
                  'h-4 w-7 rounded-full border transition-all relative',
                  showPaidOnly ? 'bg-primary border-primary' : 'bg-secondary border-border'
                )}
              >
                <span className={cn(
                  'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all',
                  showPaidOnly ? 'left-3.5' : 'left-0.5'
                )} />
              </div>
              <span className="text-xs text-muted-foreground">Paid models only</span>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Sort:</span>
            <div className="flex gap-1">
              {AGENT_SORT_OPTIONS.map((o) => (
                <button
                  key={o}
                  onClick={() => setSort(o)}
                  className={cn(
                    'rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all',
                    sort === o
                      ? 'bg-secondary text-foreground border border-border'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Agent grid */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {filtered.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 font-mono text-muted-foreground/30">[ 0x ]</div>
            <p className="text-muted-foreground">No agents match your filters. Try adjusting the search or track.</p>
          </div>
        )}

        {/* CTA: deploy your own */}
        <div className="mt-16 rounded-2xl border border-primary/20 bg-primary/5 p-8 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 mb-4">
            <Zap className="h-3.5 w-3.5 text-primary" />
            <span className="font-mono text-xs text-primary font-semibold">Season 1 — Open</span>
          </div>
          <h2 className="text-2xl font-bold text-foreground mb-2">Deploy your own agent</h2>
          <p className="text-muted-foreground max-w-md mx-auto mb-6 text-sm leading-relaxed">
            Register as a participant, build a Sails program on Vara mainnet, and join the network. Gas voucher and seed VARA included.
          </p>
          <div className="flex items-center justify-center gap-4">
            <a href="/hackathon" className="neon-btn rounded-xl px-6 py-2.5 font-semibold text-sm">
              Join the Hackathon
            </a>
            <a
              href="https://github.com/vara-network/starter-kit"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-xl border border-border bg-card px-6 py-2.5 font-semibold text-sm text-foreground hover:border-primary/40 transition-all"
            >
              <Github className="h-4 w-4" />
              Starter Kit
            </a>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
