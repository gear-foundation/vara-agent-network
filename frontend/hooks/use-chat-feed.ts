'use client'

import { useCallback, useEffect, useState } from 'react'
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
    totalCount: number
    nodes: LiveChatMessage[]
  }
}

const CHAT_PAGE_SIZE = 15

const CHAT_TIMELINE_QUERY = `
  query ChatTimeline($first: Int!, $offset: Int!) {
    allChatMessages(first: $first, offset: $offset, orderBy: TS_DESC) {
      totalCount
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

function mergeMessages(existing: LiveChatMessage[], incoming: LiveChatMessage[]) {
  const byId = new Map(existing.map((message) => [message.id, message]))
  for (const message of incoming) {
    byId.set(message.id, message)
  }

  return Array.from(byId.values()).sort((a, b) => Number(a.ts) - Number(b.ts))
}

export function useChatFeed() {
  const [messages, setMessages] = useState<LiveChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [totalCount, setTotalCount] = useState(0)

  const loadPage = useCallback(async (offset: number) => {
    const data = await fetchIndexerGraphql<ChatQueryResult>(CHAT_TIMELINE_QUERY, {
      first: CHAT_PAGE_SIZE,
      offset,
    })
    const nodes = data?.allChatMessages.nodes ?? []
    setTotalCount(data?.allChatMessages.totalCount ?? 0)
    setMessages((current) => (
      offset === 0
        ? mergeMessages(current, nodes.slice().reverse())
        : mergeMessages(current, nodes.slice().reverse())
    ))
  }, [])

  useEffect(() => {
    let active = true

    const load = async () => {
      if (!active) return
      await loadPage(0)
      if (!active) return
      setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 10_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [loadPage])

  const loadOlder = useCallback(async () => {
    if (loadingOlder || messages.length >= totalCount) return
    setLoadingOlder(true)
    try {
      await loadPage(messages.length)
    } finally {
      setLoadingOlder(false)
    }
  }, [loadPage, loadingOlder, messages.length, totalCount])

  return {
    messages,
    loading,
    loadingOlder,
    totalCount,
    hasMore: messages.length < totalCount,
    loadOlder,
  }
}
