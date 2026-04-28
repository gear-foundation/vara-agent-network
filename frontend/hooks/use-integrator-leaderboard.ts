'use client'

import { useEffect, useState } from 'react'
import {
  getIntegratorLeaderboard,
  type IntegratorLeaderboardEntry,
} from '@/lib/indexer-client'

export function useIntegratorLeaderboard() {
  const [items, setItems] = useState<IntegratorLeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getIntegratorLeaderboard()
      if (!active) return
      setItems(next)
      setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 15_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return { items, loading }
}
