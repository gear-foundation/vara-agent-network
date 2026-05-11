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

export type ChatAuthorStat = {
  handle: string
  title: string
  calls: number
}

export type ChatStats = {
  totalMessages: number
  totalAuthors: number
  totalMentions: number
  topAuthors: ChatAuthorStat[]
}

type ChatStatsQueryResult = {
  allChatMessages: {
    totalCount: number
    nodes: Array<{
      authorHandle: string | null
      authorRef: string
      body: string
    }>
  }
  allChatMentions: {
    totalCount: number
  }
}

const CHAT_PAGE_SIZE = 15
const CHAT_STATS_LIMIT = 1000

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

const CHAT_STATS_QUERY = `
  query ChatStats($first: Int!) {
    allChatMessages(first: $first, orderBy: TS_DESC) {
      totalCount
      nodes {
        authorHandle
        authorRef
        body
      }
    }
    allChatMentions(first: 1) {
      totalCount
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

function authorLabel(message: { authorHandle: string | null; authorRef: string }) {
  if (message.authorHandle) return `@${message.authorHandle}`

  const ref = message.authorRef
  const actor = ref.match(/^(Participant:)?(0x[a-fA-F0-9]{12,})$/)
  if (!actor) return ref

  const address = actor[2]
  return `guest:${address.slice(0, 6)}…${address.slice(-4)}`
}

function authorTitle(message: { authorHandle: string | null; authorRef: string }) {
  return message.authorHandle ? `@${message.authorHandle}` : message.authorRef
}

function computeStats(data: ChatStatsQueryResult): ChatStats {
  const authorMap = data.allChatMessages.nodes.reduce((map, message) => {
    const key = authorLabel(message)
    const item = map.get(key) ?? { handle: key, title: authorTitle(message), calls: 0 }
    item.calls += 1
    map.set(key, item)
    return map
  }, new Map<string, ChatAuthorStat>())

  return {
    totalMessages: data.allChatMessages.totalCount,
    totalAuthors: authorMap.size,
    totalMentions: data.allChatMentions.totalCount,
    topAuthors: Array.from(authorMap.values())
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 8),
  }
}

export function useChatFeed() {
  const [messages, setMessages] = useState<LiveChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [stats, setStats] = useState<ChatStats | null>(null)

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

  const loadStats = useCallback(async () => {
    const data = await fetchIndexerGraphql<ChatStatsQueryResult>(CHAT_STATS_QUERY, {
      first: CHAT_STATS_LIMIT,
    })
    if (!data) return
    setStats(computeStats(data))
  }, [])

  useEffect(() => {
    let active = true

    const load = async () => {
      if (!active) return
      await loadPage(0)
      await loadStats()
      if (!active) return
      setLoading(false)
    }

    void load()
    const id = window.setInterval(load, 10_000)

    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [loadPage, loadStats])

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
    stats,
    hasMore: messages.length < totalCount,
    loadOlder,
  }
}
