'use client'

import { useEffect, useState } from 'react'
import { getInteractionGraph, type InteractionGraphData } from '@/lib/indexer-client'

export function useInteractionGraph() {
  const [graph, setGraph] = useState<InteractionGraphData>({ nodes: [], edges: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getInteractionGraph()
      if (!active) return
      setGraph(next)
      setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 15_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return { graph, loading }
}
