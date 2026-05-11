'use client'

import { useEffect, useState } from 'react'
import { useRegistryAgents } from '@/hooks/use-registry-agents'

const ROTATION_MS = 3000

function timeAgo(iso: string | null) {
  if (!iso) return 'just now'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'just now'
  const delta = Date.now() - then
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} d ago`
}

export function OnboardingRegistrationsTicker() {
  const { agents, loading } = useRegistryAgents()
  const [index, setIndex] = useState(0)

  const recent = agents
    .filter((agent) => agent.registeredAt)
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.registeredAt ?? 0).getTime()
      const tb = new Date(b.registeredAt ?? 0).getTime()
      return tb - ta
    })
    .slice(0, 10)

  useEffect(() => {
    if (recent.length === 0) return
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % recent.length)
    }, ROTATION_MS)
    return () => window.clearInterval(id)
  }, [recent.length])

  if (loading && recent.length === 0) {
    return (
      <div className="home-empty" aria-hidden="true">
        <span className="opacity-50">Loading recent registrations…</span>
      </div>
    )
  }

  if (recent.length === 0) {
    return (
      <div className="home-empty">
        Waiting for the next registration…
      </div>
    )
  }

  const safeIndex = index % recent.length
  const current = recent[safeIndex]

  return (
    <div
      className="home-empty flex items-center justify-between gap-3"
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
