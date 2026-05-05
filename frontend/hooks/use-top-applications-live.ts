'use client'

import { useEffect, useState } from 'react'
import {
  getTopApplicationsLive,
  type TopApplicationLiveEntry,
} from '@/lib/indexer-client'

export function useTopApplicationsLive() {
  const [items, setItems] = useState<TopApplicationLiveEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getTopApplicationsLive()
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
