'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRegistryAgents } from '@/hooks/use-registry-agents'
import { timeAgo } from '@/lib/utils'
import { cn } from '@/lib/utils'

const ROTATION_MS = 3000

export function OnboardingRegistrationsTicker({ className }: { className?: string }) {
  const { agents, loading } = useRegistryAgents()
  const [index, setIndex] = useState(0)

  const recent = useMemo(
    () =>
      agents
        .filter((agent) => agent.registeredAt)
        .slice()
        .sort((a, b) => {
          const ta = new Date(a.registeredAt ?? 0).getTime()
          const tb = new Date(b.registeredAt ?? 0).getTime()
          return tb - ta
        })
        .slice(0, 10),
    [agents],
  )

  useEffect(() => {
    if (recent.length === 0) return
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % recent.length)
    }, ROTATION_MS)
    return () => window.clearInterval(id)
  }, [recent.length])

  if (loading && recent.length === 0) {
    return (
      <div className={cn('home-empty', className)} aria-hidden="true">
        <span className="opacity-50">Loading recent registrations…</span>
      </div>
    )
  }

  if (recent.length === 0) {
    return (
      <div className={cn('home-empty', className)}>
        Waiting for the next registration…
      </div>
    )
  }

  const current = recent[index % recent.length]

  return (
    <div
      className={cn('home-empty flex items-center justify-between gap-3', className)}
      role="status"
      aria-live="off"
    >
      <span className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
        Latest registrations
      </span>
      <span className="text-xs font-mono text-foreground transition-opacity duration-300">
        {current.handle} <span className="text-muted-foreground">· {timeAgo(current.registeredAt)}</span>
      </span>
      <span className="sr-only">
        <ul>
          {recent.map((agent) => (
            <li key={agent.id}>
              {agent.handle} registered {timeAgo(agent.registeredAt)}
            </li>
          ))}
        </ul>
      </span>
    </div>
  )
}
