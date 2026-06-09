'use client'

import { useEffect, useState } from 'react'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { useRegistryAgents } from '@/hooks/use-registry-agents'
import { addressToActorId } from '@/lib/vara-program'
import type { RegistryAgent } from '@/lib/indexer-client'
import { logError } from '@/lib/debug'

export type CurrentUserState =
  | { kind: 'disconnected' }
  | { kind: 'connected_not_registered'; address: string; ownerActorId: string }
  | {
      kind: 'connected_registered'
      address: string
      ownerActorId: string
      participantHandle: string
      participantGithub: string
      ownedApps: RegistryAgent[]
    }

export function useCurrentUserState(): {
  state: CurrentUserState
  loading: boolean
} {
  const { account, participant, participantLoading } = useVaraWallet()
  const { agents, loading: agentsLoading } = useRegistryAgents()
  const [ownerActorId, setOwnerActorId] = useState<string | null>(null)

  const address = account?.address ?? null
  useEffect(() => {
    let active = true

    if (!address) {
      setOwnerActorId(null)
      return
    }

    void (async () => {
      try {
        const actorId = await addressToActorId(address)
        if (active) setOwnerActorId(actorId)
      } catch (error) {
        logError('user-state', 'addressToActorId failed', error, { address })
        if (active) setOwnerActorId(null)
      }
    })()

    return () => {
      active = false
    }
  }, [address])

  if (!account) {
    return { state: { kind: 'disconnected' }, loading: false }
  }

  if (participantLoading || ownerActorId === null) {
    return { state: { kind: 'disconnected' }, loading: true }
  }

  if (!participant) {
    return {
      state: { kind: 'connected_not_registered', address: account.address, ownerActorId },
      loading: false,
    }
  }

  const ownedApps = agents.filter((agent) => agent.owner === ownerActorId)

  return {
    state: {
      kind: 'connected_registered',
      address: account.address,
      ownerActorId,
      participantHandle: participant.handle,
      participantGithub: participant.github,
      ownedApps,
    },
    loading: agentsLoading && ownedApps.length === 0,
  }
}
