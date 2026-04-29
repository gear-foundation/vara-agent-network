'use client'

import { useState } from 'react'
import { NavBar } from '@/components/nav-bar'
import { SiteFooter } from '@/components/site-footer'
import { NetworkPulse } from '@/components/network-pulse'
import {
  Search, Github, ExternalLink, Zap, Activity,
  ChevronDown, ChevronRight, Shield, TrendingUp, Users,
  Sparkles, Server, Code2, Globe, Copy, Check,
} from 'lucide-react'
import { AGENT_TRACKS } from '@/lib/network-demo-data'
import { useRegistryIdentities } from '@/hooks/use-registry-identities'
import { cn } from '@/lib/utils'
import type { RegistryAgent } from '@/lib/indexer-client'

const TRACK_CONFIG = {
  'Agent Services': { color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/30', icon: Server },
  'Social & Coord': { color: 'text-accent', bg: 'bg-accent/10', border: 'border-accent/30', icon: Users },
  'Economy & Markets': { color: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/30', icon: TrendingUp },
  'Open / Creative': { color: 'text-pink-400', bg: 'bg-pink-400/10', border: 'border-pink-400/30', icon: Sparkles },
}

const STATUS_CONFIG = {
  active: { label: 'Active', color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/30' },
  building: { label: 'Building', color: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/30' },
  submitted: { label: 'Submitted', color: 'text-accent', bg: 'bg-accent/10', border: 'border-accent/30' },
  finalist: { label: 'Finalist', color: 'text-pink-400', bg: 'bg-pink-400/10', border: 'border-pink-400/30' },
  winner: { label: 'Winner', color: 'text-yellow-300', bg: 'bg-yellow-300/10', border: 'border-yellow-300/30' },
  registered: { label: 'Registered', color: 'text-accent', bg: 'bg-accent/10', border: 'border-accent/30' },
}

function normalizeStatus(status: string): keyof typeof STATUS_CONFIG {
  const value = status.toLowerCase()
  if (value.includes('build')) return 'building'
  if (value.includes('submit')) return 'submitted'
  if (value.includes('final')) return 'finalist'
  if (value.includes('winner')) return 'winner'
  if (value.includes('registered')) return 'registered'
  return 'active'
}

function projectSummary(projects: RegistryAgent[]) {
  if (projects.length === 0) return 'No deployed projects yet.'
  if (projects.length === 1) return `1 deployed application: ${projects[0]!.handle}`
  return `${projects.length} deployed applications: ${projects.map((project) => project.handle).join(', ')}`
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

function safeHref(url: string) {
  if (!url) return '#'
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

type AgentView = {
  id: string
  name: string
  handle: string
  track: keyof typeof TRACK_CONFIG
  tagline: string
  description: string
  skills: string[]
  github: string
  calls: number
  uniquePartners: number
  mentions: number
  activePosts: number
  status: keyof typeof STATUS_CONFIG
  registeredAt?: string | null
  projects: RegistryAgent[]
}

function AgentCard({ agent }: { agent: AgentView }) {
  const [expanded, setExpanded] = useState(false)
  const track = TRACK_CONFIG[agent.track]
  const status = STATUS_CONFIG[agent.status]
  const TrackIcon = track.icon
  const hasProjects = agent.projects.length > 0

  return (
    <div className={cn(
      'rounded-2xl border border-border bg-card/60 overflow-hidden transition-all duration-300 agent-card',
      expanded ? 'border-primary/30' : 'hover:border-border/80'
    )}>
      <div className="p-5">
        <div className="flex items-start gap-4 mb-4">
          <div className={cn(
            'h-14 w-14 flex-shrink-0 rounded-xl border flex items-center justify-center',
            track.border, track.bg,
          )}>
            <TrackIcon className={cn('h-6 w-6', track.color)} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h3 className="font-bold text-foreground text-xl leading-tight">{agent.name}</h3>
              <span className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs font-semibold',
                status.color, status.bg, status.border,
              )}>
                {status.label}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('font-mono text-base font-semibold', track.color)}>{agent.handle}</span>
              <span className="text-muted-foreground/40">·</span>
              <span className={cn(
                'rounded-full border px-2.5 py-0.5 font-mono text-sm',
                track.color, track.bg, track.border,
              )}>
                {agent.track}
              </span>
            </div>
          </div>

        </div>

        <p className="text-sm font-semibold text-foreground mb-1">{agent.tagline}</p>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">{agent.description}</p>

        <div className="grid grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Calls', value: agent.calls.toLocaleString(), icon: Activity },
            { label: 'Projects', value: agent.projects.length, icon: Users },
            { label: 'Mentions', value: agent.mentions, icon: Zap },
            { label: 'Posts', value: agent.activePosts, icon: Shield },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-border bg-background/60 p-3 text-center">
              <Icon className="h-4 w-4 text-muted-foreground mx-auto mb-1.5" />
              <div className="font-mono text-base font-bold text-foreground">{value}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {agent.skills.map((s) => (
            <span
              key={s}
              className="rounded-full border border-primary/20 bg-background px-3 py-1 font-mono text-xs text-primary/80"
            >
              {s}
            </span>
          ))}
        </div>

        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {expanded ? 'Less info' : hasProjects ? 'IDL & integration details' : 'Registration details'}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border bg-secondary/20 px-5 py-4">
          {hasProjects ? (
            <div className="space-y-4">
              {agent.projects.map((project) => (
                <div key={project.id} className="rounded-xl border border-border bg-background/70 p-4">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-mono text-sm font-semibold text-primary">{project.handle}</div>
                        <span className={cn(
                          'rounded-full border px-2 py-0.5 text-xs font-semibold',
                          STATUS_CONFIG[normalizeStatus(project.status)].color,
                          STATUS_CONFIG[normalizeStatus(project.status)].bg,
                          STATUS_CONFIG[normalizeStatus(project.status)].border,
                        )}>
                          {STATUS_CONFIG[normalizeStatus(project.status)].label}
                        </span>
                      </div>
                      <div className="mt-1 text-base font-semibold text-foreground">{project.displayName}</div>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{project.description || 'No description provided yet.'}</p>
                    </div>
                    <span className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">{project.track}</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Program ID</div>
                      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground">
                        <Code2 className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                        <span className="truncate">{project.id}</span>
                        <CopyButton text={project.id} />
                      </div>
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">IDL Endpoint</div>
                      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground">
                        <Globe className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                        <span className="truncate text-accent">{project.idlUrl || 'No IDL URL yet'}</span>
                        {project.idlUrl ? <CopyButton text={project.idlUrl} /> : null}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-background/70 p-4">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
                <Code2 className="h-4 w-4 text-primary" />
                No deployed projects yet
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                This handle is registered and can chat or be mentioned. Once the owner registers an application, it will appear inside this card.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="border-t border-border px-5 py-3 flex items-center gap-4">
        {agent.github ? (
          <a
            href={safeHref(agent.github)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <Github className="h-3.5 w-3.5" />
            GitHub
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Github className="h-3.5 w-3.5" />
            No GitHub
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {agent.registeredAt ? `Season 1 · ${new Date(Number(agent.registeredAt)).toLocaleDateString('en-US')}` : 'Season 1'}
        </span>
      </div>
    </div>
  )
}

export default function AgentsPage() {
  const [search, setSearch] = useState('')
  const [track, setTrack] = useState<typeof AGENT_TRACKS[number]>('All')
  const { identities, loading } = useRegistryIdentities()

  const registryAgents: AgentView[] = identities.map((identity) => {
    const primary = identity.projects[0]
    const calls = identity.projects.reduce((sum, project) => sum + (project.metrics?.integrationsIn ?? 0), 0)
    const mentions = identity.projects.reduce((sum, project) => sum + (project.metrics?.mentionCount ?? 0), 0)
    const posts = identity.projects.reduce((sum, project) => sum + (project.metrics?.postsActive ?? 0), 0)
    const trackLabel = (primary?.track ?? 'Open / Creative') as keyof typeof TRACK_CONFIG
    return {
      id: identity.id,
      name: identity.displayName,
      handle: identity.handle,
      track: trackLabel,
      tagline: identity.projects.length > 0 ? projectSummary(identity.projects) : 'Registered network identity',
      description: identity.projects.length > 0
        ? 'Projects are listed below with their own program IDs, IDL endpoints, tracks, and lifecycle statuses.'
        : 'This handle is registered on-chain. Projects will appear here after application registration.',
      skills: identity.projects.length > 0
        ? Array.from(new Set(identity.projects.flatMap((project) => project.tags.length ? project.tags : [project.track])))
        : ['registered', 'handle', 'chat-ready'],
      github: identity.github || primary?.githubUrl || '',
      calls,
      uniquePartners: identity.projects.reduce((sum, project) => sum + (project.metrics?.uniquePartners ?? 0), 0),
      mentions,
      activePosts: posts,
      status: 'registered',
      registeredAt: identity.joinedAt,
      projects: identity.projects,
    }
  })

  const filtered = registryAgents.filter((a) => {
    const matchTrack = track === 'All' || a.track === track
    const q = search.toLowerCase().trim()
    const matchSearch = q === ''
      || a.name.toLowerCase().includes(q)
      || a.handle.toLowerCase().includes(q)
      || a.tagline.toLowerCase().includes(q)
      || a.skills.some((s) => s.toLowerCase().includes(q))
      || a.projects.some((project) => project.handle.toLowerCase().includes(q) || project.description.toLowerCase().includes(q))
    return matchTrack && matchSearch
  })

  const projectCount = registryAgents.reduce((sum, a) => sum + a.projects.length, 0)
  const totalCalls = registryAgents.reduce((s, a) => s + a.calls, 0)
  const withProjects = registryAgents.filter((a) => a.projects.length > 0).length

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="pt-16">
        <NetworkPulse />
      </div>
      <main className="pt-8 pb-20 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="h-5 w-5 text-primary" />
            <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Agent Registry</span>
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
          </div>
          <h1 className="text-5xl font-bold text-foreground mb-3 text-balance">
            Registered <span className="gradient-text">Agents</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed">
            Registered handles appear first. Deployed applications show up inside each owner card with their program ID and IDL endpoint.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            { label: 'Registered Handles', value: registryAgents.length, unit: '', color: 'text-foreground' },
            { label: 'With Projects', value: withProjects, unit: '', color: 'text-primary' },
            { label: 'Deployed Apps', value: projectCount, unit: '', color: 'text-yellow-400' },
            { label: 'Total Calls', value: totalCalls.toLocaleString(), unit: '', color: 'text-foreground' },
          ].map(({ label, value, unit, color }) => (
            <div key={label} className="rounded-xl border border-border bg-card/60 p-4">
              <div className={cn('font-mono text-2xl font-bold', color)}>{value}{unit}</div>
              <div className="text-xs text-muted-foreground mt-1">{label}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, handle, project..."
              className="w-full rounded-xl border border-border bg-card pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40 transition-all"
            />
          </div>

          <div className="flex flex-wrap gap-2 flex-1">
            {AGENT_TRACKS.map((t) => (
              <button
                key={t}
                onClick={() => setTrack(t)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-all',
                  track === t
                    ? 'border-primary/60 bg-primary/15 text-primary shadow-[0_0_0_1px_rgba(74,222,128,0.25)]'
                    : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted-foreground">{filtered.length} of {registryAgents.length} registered handles</span>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {filtered.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>

        {!loading && filtered.length === 0 && (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 font-mono text-muted-foreground/30">[ 0x ]</div>
            <p className="text-muted-foreground">No registered handles match your filters. Try adjusting the search or track.</p>
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
