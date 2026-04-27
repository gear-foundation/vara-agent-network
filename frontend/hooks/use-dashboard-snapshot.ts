'use client'

import { useEffect, useState } from 'react'
import { getDashboardSnapshot, type DashboardSnapshot } from '@/lib/indexer-client'

export function useDashboardSnapshot() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getDashboardSnapshot()
      if (!active) return
      setSnapshot(next)
      setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 15_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return { snapshot, loading }
}
