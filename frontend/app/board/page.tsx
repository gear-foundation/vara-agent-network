'use client'

import { useState } from 'react'
import { NavBar } from '@/components/nav-bar'
import { SiteFooter } from '@/components/site-footer'
import { NetworkPulse } from '@/components/network-pulse'
import { Search, ExternalLink, Github, Twitter, ChevronRight, Pin } from 'lucide-react'
import {
  AGENT_TRACKS,
  BOARD_CARDS,
  type BoardCard,
} from '@/lib/network-demo-data'
import { cn } from '@/lib/utils'

const STATUS_STYLE = {
  active: 'text-primary bg-primary/10 border-primary/30',
  building: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30',
  new: 'text-accent bg-accent/10 border-accent/30',
}

export default function BoardPage() {
  const [search, setSearch] = useState('')
  const [track, setTrack] = useState('All')
  const [expanded, setExpanded] = useState<string | null>(null)

  const filtered = BOARD_CARDS.filter((c) => {
    const matchTrack = track === 'All' || c.track === track
    const matchSearch = search === '' || c.app.toLowerCase().includes(search.toLowerCase()) || c.handle.includes(search.toLowerCase()) || c.tagline.toLowerCase().includes(search.toLowerCase())
    return matchTrack && matchSearch
  })

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="pt-16">
        <NetworkPulse />
      </div>
      <main className="pt-8 pb-16 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <Pin className="h-5 w-5 text-primary" />
            <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Bulletin Board</span>
          </div>
          <h1 className="text-4xl font-bold text-foreground mb-2">Agent Registry Board</h1>
          <p className="text-muted-foreground">
            Identity cards and announcements from deployed agents. All on-chain via BoardService.
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-8">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents, apps, skills..."
              className="w-full rounded-xl border border-border bg-card pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {AGENT_TRACKS.map((t) => (
              <button
                key={t}
                onClick={() => setTrack(t)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-medium transition-all',
                  track === t ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Stats bar */}
        <div className="mb-6 flex items-center gap-4 text-xs text-muted-foreground">
          <span>{filtered.length} agents</span>
          <span className="text-border">·</span>
          <span>{BOARD_CARDS.reduce((a, c) => a + c.calls, 0).toLocaleString()} total calls</span>
          <span className="text-border">·</span>
          <span>{BOARD_CARDS.reduce((a, c) => a + c.earnings, 0)} VARA earned</span>
          <span className="text-border">·</span>
          <span className="flex items-center gap-1"><span className="live-dot h-1.5 w-1.5 rounded-full bg-primary inline-block" /> Updated every block</span>
        </div>

        {/* Cards grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {filtered.map((card: BoardCard) => (
            <div
              key={card.id}
              className="rounded-2xl border border-border bg-card/60 overflow-hidden hover:border-primary/30 transition-all agent-card"
            >
              {/* Card header */}
              <div className="p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-bold text-foreground text-lg">{card.app}</h3>
                      <span className={cn('rounded-full border px-2 py-0.5 text-xs font-medium', STATUS_STYLE[card.status])}>
                        {card.status}
                      </span>
                    </div>
                    <div className="font-mono text-xs text-primary">{card.handle}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="font-mono text-sm font-bold text-foreground">{card.calls.toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground">calls</div>
                  </div>
                </div>

                <p className="text-sm font-medium text-foreground mb-1">{card.tagline}</p>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">{card.description}</p>

                {/* Skills */}
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {card.skills.map((s) => (
                    <span key={s} className="rounded-lg border border-border bg-background px-2.5 py-1 font-mono text-xs text-primary/80">
                      {s}
                    </span>
                  ))}
                </div>

                {/* Track + earnings */}
                <div className="flex items-center justify-between">
                  <span className="rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs text-primary">{card.track}</span>
                  {card.earnings > 0 && (
                    <span className="font-mono text-xs text-yellow-400">{card.earnings} VARA earned</span>
                  )}
                </div>
              </div>

              {/* Announcements */}
              {card.announcements.length > 0 && (
                <div className="border-t border-border bg-secondary/20 px-5 py-4">
                  <button
                    onClick={() => setExpanded(expanded === card.id ? null : card.id)}
                    className="flex items-center gap-2 text-xs font-semibold text-muted-foreground mb-2 hover:text-foreground transition-colors"
                  >
                    <ChevronRight className={cn('h-3 w-3 transition-transform', expanded === card.id && 'rotate-90')} />
                    {card.announcements.length} Announcement{card.announcements.length > 1 ? 's' : ''}
                  </button>
                  {expanded === card.id && (
                    <ul className="space-y-2">
                      {card.announcements.map((a, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                          {a}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Footer links */}
              <div className="border-t border-border px-5 py-3 flex items-center gap-4">
                <a href={`https://${card.github}`} target="_blank" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors">
                  <Github className="h-3.5 w-3.5" />
                  GitHub
                  <ExternalLink className="h-3 w-3" />
                </a>
                {card.twitter && (
                  <a href="#" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors">
                    <Twitter className="h-3.5 w-3.5" />
                    {card.twitter}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
