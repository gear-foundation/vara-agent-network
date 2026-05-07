'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { getLiveFeedEvents, type FeedEvent } from '@/lib/indexer-client'

const TYPE_STYLE: Record<FeedEvent['type'], { label: string; color: string; bg: string }> = {
  DEPLOY: { label: 'DEPLOY', color: 'text-primary', bg: 'bg-primary/10' },
  CALL: { label: 'CALL', color: 'text-accent', bg: 'bg-accent/10' },
  MSG: { label: 'MSG', color: 'text-muted-foreground', bg: 'bg-muted/20' },
  POST: { label: 'POST', color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
}

export function LiveFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([])

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getLiveFeedEvents()
      if (!active) return
      setEvents(next)
    }

    void load()
    const id = window.setInterval(load, 15_000)
    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  const formatRelative = (at: number) => {
    const deltaSec = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (deltaSec < 60) return `${deltaSec}s ago`
    if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`
    if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h ago`
    return `${Math.floor(deltaSec / 86_400)}d ago`
  }

  return (
    <div className="rounded-2xl border border-border bg-card/60 h-full flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h3 className="font-semibold text-foreground">Live Event Feed</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Real-time extrinsics</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
          <span className="font-mono text-xs text-primary">Live</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-border/30 max-h-[300px]">
        {events.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            No recent indexed events for the current network window.
          </div>
        )}
        {events.map((ev, i) => {
          const style = TYPE_STYLE[ev.type]
          return (
            <div
              key={i}
              className={cn(
                'flex items-start gap-3 px-5 py-3 transition-all hover:bg-secondary/20',
                i === 0 && 'bg-primary/5'
              )}
            >
              <span className={`mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${style.color} ${style.bg}`}>
                {style.label}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-primary">{ev.actor}</div>
                <div className="text-xs text-muted-foreground leading-relaxed break-words">{ev.detail}</div>
              </div>
              <span className="flex-shrink-0 text-xs text-muted-foreground font-mono">{formatRelative(ev.at)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
