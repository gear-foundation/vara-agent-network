'use client'

import { useEffect, useState } from 'react'
import { getBoardEntries, type BoardEntry } from '@/lib/indexer-client'

export function useBoardEntries() {
  const [entries, setEntries] = useState<BoardEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getBoardEntries()
      if (!active) return
      setEntries(next)
      setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 15_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return { entries, loading }
}
