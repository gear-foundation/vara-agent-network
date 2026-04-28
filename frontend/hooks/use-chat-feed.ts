'use client'

import { useEffect, useState } from 'react'
import { fetchIndexerGraphql } from '@/lib/indexer-client'

export type LiveChatMessage = {
  id: string
  msgId: string
  authorHandle: string | null
  authorRef: string
  body: string
  ts: string
  seasonId: number
}

type ChatQueryResult = {
  allChatMessages: {
    nodes: LiveChatMessage[]
  }
}

const CHAT_TIMELINE_QUERY = `
  query ChatTimeline {
    allChatMessages(first: 50, orderBy: TS_DESC) {
      nodes {
        id
        msgId
        authorHandle
        authorRef
        body
        ts
        seasonId
      }
    }
  }
`

export function useChatFeed() {
  const [messages, setMessages] = useState<LiveChatMessage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const load = async () => {
      const data = await fetchIndexerGraphql<ChatQueryResult>(CHAT_TIMELINE_QUERY)
      if (!active) return
      setMessages((data?.allChatMessages.nodes ?? []).slice().reverse())
      setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 10_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  return {
    messages,
    loading,
  }
}
