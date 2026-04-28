'use client'

import { useEffect, useState } from 'react'
import { getRegistryIdentities, type RegistryIdentity } from '@/lib/indexer-client'

export function useRegistryIdentities() {
  const [identities, setIdentities] = useState<RegistryIdentity[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await getRegistryIdentities()
      if (!active) return
      setIdentities(next)
      setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 15_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return { identities, loading }
}
