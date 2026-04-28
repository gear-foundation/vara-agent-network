'use client'

import { useEffect, useState } from 'react'
import { getRegistryAgents, type RegistryAgent } from '@/lib/indexer-client'

export function useRegistryAgents() {
  const [agents, setAgents] = useState<RegistryAgent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getRegistryAgents()
      if (!active) return
      setAgents(next)
      setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 15_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return { agents, loading }
}
