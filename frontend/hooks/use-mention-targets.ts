'use client'

import { useEffect, useState } from 'react'
import { getMentionTargets, type MentionTarget } from '@/lib/indexer-client'

export function useMentionTargets() {
  const [targets, setTargets] = useState<MentionTarget[]>([])

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getMentionTargets()
      if (!active) return
      setTargets(next)
    }

    void load()
    const id = window.setInterval(load, 15_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return { targets }
}
