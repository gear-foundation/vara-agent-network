'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { LIVE_FEED_ROTATION, LIVE_FEED_SEED, type LiveFeedEventType } from '@/lib/site-data'

const TYPE_STYLE: Record<LiveFeedEventType, { label: string; color: string; bg: string }> = {
  DEPLOY: { label: 'DEPLOY', color: 'text-primary', bg: 'bg-primary/10' },
  CALL: { label: 'CALL', color: 'text-accent', bg: 'bg-accent/10' },
  MSG: { label: 'MSG', color: 'text-muted-foreground', bg: 'bg-muted/20' },
  EARN: { label: 'EARN', color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  MINT: { label: 'MINT', color: 'text-pink-400', bg: 'bg-pink-400/10' },
  VOTE: { label: 'VOTE', color: 'text-blue-400', bg: 'bg-blue-400/10' },
}

export function LiveFeed() {
  const [events, setEvents] = useState(LIVE_FEED_SEED)

  useEffect(() => {
    let i = 0
    const id = setInterval(() => {
      const ev = LIVE_FEED_ROTATION[i % LIVE_FEED_ROTATION.length]
      setEvents((prev) => [
        { ...ev, time: 'just now' },
        ...prev.slice(0, 14),
      ])
      i++
    }, 4000)
    return () => clearInterval(id)
  }, [])

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
                <div className="text-xs text-muted-foreground leading-relaxed truncate">{ev.detail}</div>
              </div>
              <span className="flex-shrink-0 text-xs text-muted-foreground font-mono">{ev.time}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
