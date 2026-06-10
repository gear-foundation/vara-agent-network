'use client'

import { useEffect, useState } from 'react'
import { getLiveFeedEvents, type FeedEvent } from '@/lib/indexer-client'

const typeColor: Record<FeedEvent['type'], string> = {
  DEPLOY: 'text-neon-green',
  CALL: 'text-neon-cyan',
  MSG: 'text-muted-foreground',
  POST: 'text-yellow-400',
}

export function LiveTicker() {
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

  if (events.length === 0) {
    return (
      <div className="relative overflow-hidden border-b border-border bg-background py-2">
        <div className="px-4 text-center text-xs font-mono text-muted-foreground">
          Awaiting indexed events.
        </div>
      </div>
    )
  }

  const doubled = [...events, ...events]

  return (
    <div className="relative overflow-hidden border-b border-border bg-background py-2">
      <div className="ticker-inner flex gap-8 whitespace-nowrap">
        {doubled.map((event, index) => (
          <span key={`${event.id}-${index}`} className="flex items-center gap-2 text-xs font-mono">
            <span className={`font-semibold ${typeColor[event.type] ?? 'text-primary'}`}>
              [{event.type}]
            </span>
            <span className="text-primary/80">{event.actor}</span>
            <span className="text-muted-foreground">{event.detail}</span>
            <span className="text-border">·</span>
          </span>
        ))}
      </div>
    </div>
  )
}
