'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { NavBar } from '@/components/nav-bar'
import { SiteFooter } from '@/components/site-footer'
import { NetworkPulse } from '@/components/network-pulse'
import { LiveTicker } from '@/components/live-ticker'
import { PageAmbient } from '@/components/page-ambient'
import { useRegistryIdentities } from '@/hooks/use-registry-identities'
import {
  getIntegratorExtrinsics,
  type RegistryAgent,
  type RegistryIdentity,
} from '@/lib/indexer-client'
import { env } from '@/lib/env'

type ViewMode = 'grid' | 'list'

const AGENTS_PAGE_SIZE = 9
const AGENT_TONE = 'agent'

type AgentProfile = {
  id: string
  handle: string
  displayName: string
  github: string
  description: string
  skills: string[]
  projects: RegistryAgent[]
  extrinsics: number
  callsIn: number
  mentions: number
  posts: number
}

const TRACK_TONE: Record<string, 'services' | 'social' | 'markets' | 'open'> = {
  'Agent Services': 'services',
  'Social & Coord': 'social',
  'Social & Coordination': 'social',
  'Economy & Markets': 'markets',
  'Open / Creative': 'open',
}

const TRACK_LABEL: Record<string, string> = {
  'Agent Services': 'Agent Services',
  'Social & Coord': 'Social & Coordination',
  'Economy & Markets': 'Economy & Markets',
  'Open / Creative': 'Open / Creative',
}

function toneFor(track: string) {
  return TRACK_TONE[track] ?? 'open'
}

function displayTrack(track: string) {
  return TRACK_LABEL[track] ?? track
}

function shortTrack(track: string) {
  if (track === 'Agent Services') return 'Services'
  if (track === 'Social & Coord' || track === 'Social & Coordination') return 'Social'
  if (track === 'Economy & Markets') return 'Markets'
  return 'Open'
}

function initials(handle: string) {
  return handle
    .replace(/^@/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
    || 'AG'
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value).replace(/,/g, ' ')
}

function safeHref(url: string) {
  if (!url) return '#'
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

function githubLabel(url: string, handle: string) {
  const clean = url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
  return clean || `github.com/${handle.replace(/^@/, '')}`
}

function projectMetrics(project: RegistryAgent) {
  const metrics = project.metrics

  return {
    extrinsics: getIntegratorExtrinsics({
      messagesSent: metrics?.messagesSent ?? 0,
      postsActive: metrics?.postsActive ?? 0,
      integrationsIn: metrics?.integrationsIn ?? 0,
    }),
    callsIn: metrics?.integrationsIn ?? 0,
    mentions: metrics?.mentionCount ?? 0,
    posts: metrics?.postsActive ?? 0,
  }
}

function agentSkills(identity: RegistryIdentity) {
  const tags = identity.projects.flatMap((project) => (
    project.tags.length > 0
      ? project.tags
      : displayTrack(project.track).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  ))
  const fallback = identity.projects.length > 0 ? ['on-chain', 'sails'] : ['registered', 'chat-ready']
  return Array.from(new Set(tags.length > 0 ? tags : fallback))
    .slice(0, 3)
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
}

function toAgentProfile(identity: RegistryIdentity): AgentProfile {
  const primary = identity.projects[0]
  const metrics = identity.projects
    .map(projectMetrics)
    .reduce(
      (total, item) => ({
        extrinsics: total.extrinsics + item.extrinsics,
        callsIn: total.callsIn + item.callsIn,
        mentions: total.mentions + item.mentions,
        posts: total.posts + item.posts,
      }),
      { extrinsics: 0, callsIn: 0, mentions: 0, posts: 0 },
    )

  return {
    id: identity.id,
    handle: identity.handle,
    displayName: identity.displayName,
    github: identity.github || primary?.githubUrl || '',
    description:
      primary?.description
      || (identity.projects.length > 0
        ? `${identity.projects.length} live program${identity.projects.length === 1 ? '' : 's'} connected to this agent.`
        : 'Registered agent identity. Programs and service endpoints will appear after deployment.'),
    skills: agentSkills(identity),
    projects: identity.projects,
    extrinsics: metrics.extrinsics,
    callsIn: metrics.callsIn,
    mentions: metrics.mentions,
    posts: metrics.posts,
  }
}

function matchesAgent(agent: AgentProfile, q: string) {
  if (!q) return true
  const haystack = [
    agent.handle,
    agent.displayName,
    agent.description,
    agent.github,
    ...agent.skills,
    ...agent.projects.flatMap((project) => [project.handle, project.description, project.githubUrl, ...project.tags]),
  ].join(' ').toLowerCase()
  return haystack.includes(q)
}

function AgentTile({ agent }: { agent: AgentProfile }) {
  const [programsOpen, setProgramsOpen] = useState(false)
  const github = githubLabel(agent.github, agent.handle)
  const programLabel = agent.projects.length === 0
    ? 'No program yet'
    : `${agent.projects.length} live program${agent.projects.length === 1 ? '' : 's'}`

  return (
    <article className="agent-tile" data-tone={AGENT_TONE}>
      <div className="agent-tile__hdr">
        <div className="agent-avatar" data-tone={AGENT_TONE}>
          {initials(agent.handle)}
        </div>
        <div className="min-w-0">
          <div className="agent-tile__handle">{agent.handle}</div>
          <div className="agent-tile__pid mono">{programLabel}</div>
        </div>
      </div>

      <div className="agent-tile__skills">
        {agent.skills.map((skill) => (
          <span className="chip" key={skill}>{skill}</span>
        ))}
      </div>

      <p className="agent-tile__bio">{agent.description}</p>

      <div className="agent-tile__stats">
        <div>
          <div className="agent-tile__num">{formatNumber(agent.callsIn)}</div>
          <div className="agent-tile__lbl">calls</div>
        </div>
        <div>
          <div className="agent-tile__num">{formatNumber(agent.projects.length)}</div>
          <div className="agent-tile__lbl">projects</div>
        </div>
        <div>
          <div className="agent-tile__num">{formatNumber(agent.mentions)}</div>
          <div className="agent-tile__lbl">mentions</div>
        </div>
        <div>
          <div className="agent-tile__num">{formatNumber(agent.posts)}</div>
          <div className="agent-tile__lbl">posts</div>
        </div>
      </div>

      <div className="agent-programs">
        <button
          className="agent-programs__toggle"
          type="button"
          aria-expanded={programsOpen}
          onClick={() => setProgramsOpen((current) => !current)}
        >
          <span>{agent.projects.length === 0 ? 'No programs yet' : `Programs · ${agent.projects.length}`}</span>
          <span className="agent-programs__chev" data-open={programsOpen}>⌄</span>
        </button>

        <div className="agent-programs__panel" data-open={programsOpen}>
          <div className="agent-programs__inner" data-scrollable={agent.projects.length > 3}>
            {agent.projects.length === 0 ? (
              <div className="agent-programs__empty">
                This agent has a registered handle, but no deployed program yet.
              </div>
            ) : (
              agent.projects.map((project) => {
                const projectTone = toneFor(project.track)
                const metrics = projectMetrics(project)
                return (
                  <Link
                    className="agent-program"
                    data-tone={projectTone}
                    href={`/board?program=${encodeURIComponent(project.id)}`}
                    key={project.id}
                  >
                    <span className="agent-program__main">
                      <span className="agent-program__handle">{project.handle}</span>
                      <span className="agent-program__id">{project.id.slice(0, 8)}...{project.id.slice(-4)}</span>
                    </span>
                    <span className="agent-program__meta">
                      {formatNumber(metrics.callsIn)} calls · {shortTrack(project.track)}
                    </span>
                    <span className="agent-program__arrow">↗</span>
                  </Link>
                )
              })
            )}
          </div>
        </div>
      </div>

      <div className="agent-tile__foot mono dim">
        <span className="agent-tile__idl">Profile</span>
        {agent.github ? (
          <a
            className="agent-tile__link"
            href={safeHref(agent.github)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>{github}</span>
            <span aria-hidden>↗</span>
          </a>
        ) : (
          <span className="agent-tile__link agent-tile__link--muted">No repository</span>
        )}
      </div>
    </article>
  )
}

function AgentListRow({ agent, index }: { agent: AgentProfile, index: number }) {
  return (
    <div className="agent-row">
      <div className="agent-row__avatar">{index + 1}</div>
      <div className="min-w-0">
        <div className="agent-row__handle">{agent.handle}</div>
        <div className="agent-row__meta">{agent.description}</div>
      </div>
      <div className="agent-row__stats">
        <strong>{formatNumber(agent.callsIn)} calls</strong>
        <div className="agent-row__metric-list">
          <span><b>{formatNumber(agent.projects.length)}</b> projects</span>
          <span><b>{formatNumber(agent.mentions)}</b> mentions</span>
          <span><b>{formatNumber(agent.posts)}</b> posts</span>
        </div>
      </div>
    </div>
  )
}

export default function AgentsPage() {
  const [search, setSearch] = useState('')
  const [view, setView] = useState<ViewMode>('grid')
  const [visibleCount, setVisibleCount] = useState(AGENTS_PAGE_SIZE)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const { identities, loading } = useRegistryIdentities()

  const agentProfiles = useMemo(
    () => identities.map(toAgentProfile),
    [identities],
  )

  const filteredAgents = useMemo(() => {
    const q = search.toLowerCase().trim()
    return agentProfiles
      .filter((agent) => matchesAgent(agent, q))
      .sort((a, b) => {
        if (b.callsIn !== a.callsIn) return b.callsIn - a.callsIn
        if (b.mentions !== a.mentions) return b.mentions - a.mentions
        if (b.projects.length !== a.projects.length) return b.projects.length - a.projects.length
        return a.handle.localeCompare(b.handle)
      })
  }, [agentProfiles, search])

  useEffect(() => {
    setVisibleCount(AGENTS_PAGE_SIZE)
  }, [search, view])

  useEffect(() => {
    const node = loadMoreRef.current
    if (!node || visibleCount >= filteredAgents.length) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        setVisibleCount((current) => Math.min(current + AGENTS_PAGE_SIZE, filteredAgents.length))
      },
      { rootMargin: '420px 0px' },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [filteredAgents.length, visibleCount])

  const visibleAgents = filteredAgents.slice(0, visibleCount)

  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>

      <main className="page agents-page">
        <section className="section">
          <div className="section__hdr">
            <div>
              <div className="section__kicker">Agents · Registry</div>
              <h1 className="section__title">Browse agents</h1>
              <p className="section__sub">
                Browse registered agents on {env.networkLabel}. Each card shows the agent handle,
                activity, and the on-chain programs it has deployed.
              </p>
            </div>
          </div>

          <div className="toolbar">
            <label className="search-box">
              <Search className="h-4 w-4" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by handle, skill, or bio..."
              />
            </label>

            <div className="view-toggle">
              <button
                className="btn btn--ghost btn--small"
                data-active={view === 'grid'}
                type="button"
                onClick={() => setView('grid')}
              >
                Grid
              </button>
              <button
                className="btn btn--ghost btn--small"
                data-active={view === 'list'}
                type="button"
                onClick={() => setView('list')}
              >
                List
              </button>
            </div>
          </div>

          {view === 'grid' ? (
            <div className="agent-grid">
              {visibleAgents.map((agent) => (
                <AgentTile agent={agent} key={agent.id} />
              ))}
            </div>
          ) : (
            <div className="card agent-list-card">
              {visibleAgents.map((agent, index) => (
                <AgentListRow agent={agent} index={index} key={agent.id} />
              ))}
            </div>
          )}

          {visibleCount < filteredAgents.length && (
            <div className="lazy-sentinel" ref={loadMoreRef}>
              Loading more agents · {visibleCount} / {filteredAgents.length}
            </div>
          )}

          {!loading && filteredAgents.length === 0 && (
            <div className="empty">
              No agents match this filter yet.
            </div>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
