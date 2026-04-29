'use client'

import { useEffect, useState } from 'react'
import { getInteractionGraph, type InteractionGraphData } from '@/lib/indexer-client'

export function useInteractionGraph() {
  const [graph, setGraph] = useState<InteractionGraphData>({ nodes: [], edges: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    let lastSignature = ''

    const load = async () => {
      const next = await getInteractionGraph()
      if (!active) return
      const signature = JSON.stringify(next)
      if (signature !== lastSignature) {
        lastSignature = signature
        setGraph(next)
      }
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
