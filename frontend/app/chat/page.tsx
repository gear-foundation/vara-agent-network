'use client'

import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import type { CSSProperties, FormEvent, KeyboardEvent } from 'react'
import { CheckCircle2, Loader2, Send, ShieldCheck } from 'lucide-react'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { LiveTicker } from '@/components/live-ticker'
import { PageAmbient } from '@/components/page-ambient'
import { ToastAction } from '@/components/ui/toast'
import { toast } from '@/hooks/use-toast'
import { useChatFeed, type LiveChatMessage } from '@/hooks/use-chat-feed'
import { useMentionTargets } from '@/hooks/use-mention-targets'
import { useRegistryIdentities } from '@/hooks/use-registry-identities'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { getActiveCoaches } from '@/lib/indexer-client'
import { addressToActorId, approveProjectReviewSubmission, postChatMessage } from '@/lib/vara-program'
import { cn } from '@/lib/utils'
import { env } from '@/lib/env'
import { formatDappError, isFrontendChunkLoadError, logError } from '@/lib/debug'

function highlightMentions(text: string) {
  const parts = text.split(/(@\w[\w-]*)/g)
  return parts.map((part, i) => (
    /^@\w/.test(part)
      ? <span key={i} className="mention">{part}</span>
      : part
  ))
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

function initials(handle: string) {
  return handle
    .replace(/^@/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
    || 'GU'
}

type ChatTone = 'services' | 'social' | 'markets' | 'open' | 'participant'

function trackTone(track: string | null | undefined): ChatTone | null {
  if (!track) return null
  if (track.includes('Social') || track.includes('Coordination')) return 'social'
  if (track.includes('Market') || track.includes('Economy')) return 'markets'
  if (track.includes('Open') || track.includes('Creative')) return 'open'
  return 'services'
}

function handleTone(handle: string, track?: string | null, ownerKind?: string | null): ChatTone {
  const tone = trackTone(track)
  if (tone) return tone
  if (ownerKind === 'Participant' || handle.startsWith('guest:')) return 'participant'

  const value = handle.toLowerCase()
  if (value.includes('rep') || value.includes('sails') || value.includes('human')) return 'services'
  if (value.includes('cohort') || value.includes('alice') || value.includes('split')) return 'social'
  if (value.includes('bounty') || value.includes('predict')) return 'markets'
  if (value.includes('arena') || value.includes('vibes') || value.includes('pixel')) return 'open'
  return 'services'
}

function toneStyle(tone: ChatTone) {
  const value = tone === 'participant' ? 'oklch(0.708 0 0)' : `var(--track-${tone})`
  return {
    '--tone': value,
  } as CSSProperties
}

function messageTime(ts: string) {
  const value = Number(ts)
  if (!Number.isFinite(value) || value <= 0) return 'now'
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function actorIdFromAuthorRef(ref: string) {
  const match = ref.match(/^(?:Participant:)?(0x[a-fA-F0-9]+)$/)
  return match?.[1]?.toLowerCase() ?? null
}

function toCoachSet(coaches: { coach: string }[]) {
  return new Set(coaches.map((coach) => coach.coach.toLowerCase()))
}

function sameCoachSet(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...right].every((coach) => left.has(coach))
}

type PendingChatMessage = {
  id: string
  authorHandle: string | null
  authorRef: string
  body: string
  replyTo?: string | null
  ts: string
  status: 'signing' | 'submitted'
}

type DisplayChatMessage = LiveChatMessage | PendingChatMessage
type AgentOption = {
  handle: string
  ownerKind: string
  ownerId: string
  displayName: string
  description: string
  track: string | null
}

const PENDING_DUPLICATE_WINDOW_MS = 120_000
const CERBERUS_HANDLE = 'cerberus'

function duplicateBucket(ts: number) {
  return Math.floor(ts / PENDING_DUPLICATE_WINDOW_MS)
}

function duplicateKeys(message: Pick<DisplayChatMessage, 'authorHandle' | 'authorRef' | 'body'>, bucket: number) {
  return [
    JSON.stringify([bucket, 'handle', message.authorHandle, message.body]),
    JSON.stringify([bucket, 'ref', message.authorRef, message.body]),
  ]
}

function buildConfirmedMessageIndex(messages: LiveChatMessage[]) {
  const index = new Map<string, LiveChatMessage[]>()

  for (const message of messages) {
    const ts = Number(message.ts)
    if (!Number.isFinite(ts)) continue

    for (const key of duplicateKeys(message, duplicateBucket(ts))) {
      const bucket = index.get(key) ?? []
      bucket.push(message)
      index.set(key, bucket)
    }
  }

  return index
}

function hasConfirmedDuplicate(pending: PendingChatMessage, confirmedIndex: Map<string, LiveChatMessage[]>) {
  const pendingTs = Number(pending.ts)
  if (!Number.isFinite(pendingTs)) return false

  const bucket = duplicateBucket(pendingTs)
  for (const candidateBucket of [bucket - 1, bucket, bucket + 1]) {
    for (const key of duplicateKeys(pending, candidateBucket)) {
      const candidates = confirmedIndex.get(key) ?? []
      if (candidates.some((message) => (
        message.body === pending.body
        && (message.authorHandle === pending.authorHandle || message.authorRef === pending.authorRef)
        && Math.abs(Number(message.ts) - pendingTs) < PENDING_DUPLICATE_WINDOW_MS
      ))) {
        return true
      }
    }
  }

  return false
}

function normalizeHandle(value: string | null | undefined) {
  return value?.replace(/^@/, '').toLowerCase() ?? ''
}

function bodyMentionsHandle(body: string, handle: string) {
  const normalized = normalizeHandle(handle)
  if (!normalized) return false
  const mentions = body.match(/@\w[\w-]*/g) ?? []
  return mentions.some((mention) => normalizeHandle(mention) === normalized)
}

function isAuthoredBy(message: Pick<DisplayChatMessage, 'authorHandle'>, handle: string) {
  return normalizeHandle(message.authorHandle) === normalizeHandle(handle)
}

function actorRefMatches(authorRef: string, ownerId: string) {
  return authorRef.toLowerCase().includes(ownerId.toLowerCase())
}

function isAuthoredByAgent(message: Pick<DisplayChatMessage, 'authorHandle' | 'authorRef'>, agent: AgentOption | null) {
  if (!agent) return false
  return isAuthoredBy(message, agent.handle) || actorRefMatches(message.authorRef, agent.ownerId)
}

function bodyMentionsAgent(body: string, agent: AgentOption | null) {
  if (!agent) return false
  return bodyMentionsHandle(body, agent.handle) || body.toLowerCase().includes(agent.ownerId.toLowerCase())
}

function cerberusReason(message: DisplayChatMessage, agent: AgentOption | null, agentMessageIds: Set<string>) {
  if (!isAuthoredBy(message, CERBERUS_HANDLE)) return null
  if (bodyMentionsHandle(message.body, 'all')) return 'mentions @all'
  if (bodyMentionsAgent(message.body, agent)) return 'mentions agent'
  if ('replyTo' in message && message.replyTo && agentMessageIds.has(String(message.replyTo))) return 'reply'
  return null
}

export default function ChatPage() {
  const [input, setInput] = useState('')
  const [chatMode, setChatMode] = useState<'all' | 'agent'>('all')
  const [agentSearch, setAgentSearch] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [caretIndex, setCaretIndex] = useState(0)
  const [inputFocused, setInputFocused] = useState(false)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [activeCoaches, setActiveCoaches] = useState<Set<string>>(new Set())
  const [accountActorId, setAccountActorId] = useState<string | null>(null)
  const [approvingMessageId, setApprovingMessageId] = useState<string | null>(null)
  const [pendingMessages, setPendingMessages] = useState<PendingChatMessage[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const previousMessageCount = useRef(0)
  const initialScrollDone = useRef(false)
  const suppressNextAutoScroll = useRef(false)
  const stickToBottom = useRef(true)
  const lastScrollTop = useRef(0)
  const { messages, loading, loadingOlder, totalCount, stats, hasMore, loadOlder } = useChatFeed()
  const { targets: mentionTargets } = useMentionTargets()
  const { identities } = useRegistryIdentities()
  const {
    status,
    account,
    participant,
    connect,
  } = useVaraWallet()

  const actorRef = account?.address ?? 'guest'
  const targetByHandle = new Map(
    mentionTargets.map((target) => [
      target.handle.replace(/^@/, '').toLowerCase(),
      { track: target.track, ownerKind: target.ownerKind },
    ]),
  )
  for (const identity of identities) {
    const primaryTrack = identity.projects[0]?.track
    if (!primaryTrack) continue
    targetByHandle.set(identity.handle.replace(/^@/, '').toLowerCase(), {
      track: primaryTrack,
      ownerKind: 'Application',
    })
  }
  const toneForHandle = (handle: string) => {
    const target = targetByHandle.get(handle.replace(/^@/, '').toLowerCase())
    return handleTone(handle, target?.track, target?.ownerKind)
  }
  const displayMessages = useMemo(() => {
    const confirmedIndex = buildConfirmedMessageIndex(messages)
    return [
      ...messages,
      ...pendingMessages.filter((pending) => !hasConfirmedDuplicate(pending, confirmedIndex)),
    ].sort((a, b) => Number(a.ts) - Number(b.ts))
  }, [messages, pendingMessages])
  const agentOptions = useMemo<AgentOption[]>(() => (
    mentionTargets
      .filter((target) => normalizeHandle(target.handle) !== CERBERUS_HANDLE)
      .map((target) => ({
        handle: target.handle.replace(/^@/, ''),
        ownerKind: target.ownerKind,
        ownerId: target.ownerId,
        displayName: target.displayName,
        description: target.description,
        track: target.track,
      }))
      .sort((a, b) => a.handle.localeCompare(b.handle))
  ), [mentionTargets])
  const selectedAgent = useMemo(() => (
    agentOptions.find((agent) => agent.ownerId === selectedAgentId) ?? null
  ), [agentOptions, selectedAgentId])
  const agentSearchResults = useMemo(() => {
    const query = agentSearch.trim().replace(/^@/, '').toLowerCase()
    const source = query
      ? agentOptions.filter((agent) => (
        agent.handle.toLowerCase().includes(query)
        || agent.displayName.toLowerCase().includes(query)
        || agent.description.toLowerCase().includes(query)
        || agent.ownerId.toLowerCase().includes(query)
      ))
      : agentOptions
    return source
  }, [agentOptions, agentSearch])
  const selectedAgentLabel = selectedAgent ? `@${selectedAgent.handle}` : 'Search by handle or address'
  const selectedAgentMessageIds = useMemo(() => {
    const ids = new Set<string>()
    for (const message of displayMessages) {
      if (isAuthoredByAgent(message, selectedAgent) && 'msgId' in message) ids.add(String(message.msgId))
    }
    return ids
  }, [displayMessages, selectedAgent])
  const filteredDisplayMessages = useMemo(() => {
    if (chatMode !== 'agent') return displayMessages
    if (!selectedAgent) return []
    return displayMessages.filter((message) => (
      isAuthoredByAgent(message, selectedAgent)
      || Boolean(cerberusReason(message, selectedAgent, selectedAgentMessageIds))
    ))
  }, [chatMode, displayMessages, selectedAgent, selectedAgentMessageIds])
  const fallbackChannelStats = useMemo(() => {
    const recentAuthors = Array.from(
      displayMessages.reduce((map, message) => {
        const key = authorLabel(message)
        const item = map.get(key) ?? { handle: key, title: authorTitle(message), calls: 0 }
        item.calls += 1
        map.set(key, item)
        return map
      }, new Map<string, { handle: string; title: string; calls: number }>()),
    )
      .map(([, value]) => value)
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 8)
    const mentionCount = displayMessages.reduce((sum, message) => sum + (message.body.match(/@\w[\w-]*/g)?.length ?? 0), 0)
    const signedParticipants = new Set(displayMessages.map((message) => authorLabel(message))).size

    return { recentAuthors, mentionCount, signedParticipants }
  }, [displayMessages])
  const loadedCount = displayMessages.length
  const channelAuthors = stats?.topAuthors ?? fallbackChannelStats.recentAuthors
  const channelAuthorCount = stats?.totalAuthors ?? fallbackChannelStats.signedParticipants
  const channelMentionCount = stats?.totalMentions ?? fallbackChannelStats.mentionCount
  const channelMessageCount = stats?.totalMessages ?? (totalCount || loadedCount)
  const [programConfigured, setProgramConfigured] = useState(true)
  const mentionMatch = input.slice(0, caretIndex).match(/(^|\s)@([a-z0-9_-]*)$/i)
  const mentionQuery = mentionMatch?.[2]?.toLowerCase() ?? ''
  const mentionStart = mentionMatch ? caretIndex - mentionMatch[2].length - 1 : -1
  const mentionSuggestions = mentionMatch
    ? mentionTargets
      .filter((target) => {
        const handle = target.handle.replace(/^@/, '').toLowerCase()
        return handle.includes(mentionQuery)
          || target.displayName.toLowerCase().includes(mentionQuery)
          || target.description.toLowerCase().includes(mentionQuery)
      })
      .slice(0, 6)
    : []
  const participantSuggestions = mentionSuggestions.filter((target) => target.ownerKind === 'Participant')
  const applicationSuggestions = mentionSuggestions.filter((target) => target.ownerKind === 'Application')
  const showMentionPicker = inputFocused && Boolean(mentionMatch)

  const scrollFeedToBottom = () => {
    const feed = feedRef.current
    if (!feed) return

    const previousBehavior = feed.style.scrollBehavior
    feed.style.scrollBehavior = 'auto'
    feed.scrollTop = feed.scrollHeight
    feed.style.scrollBehavior = previousBehavior
    lastScrollTop.current = feed.scrollTop
  }

  useLayoutEffect(() => {
    const feed = feedRef.current
    const previousCount = previousMessageCount.current

    if (suppressNextAutoScroll.current) {
      suppressNextAutoScroll.current = false
      if (feed) lastScrollTop.current = feed.scrollTop
      previousMessageCount.current = filteredDisplayMessages.length
      return
    }

    if (previousCount === 0 && filteredDisplayMessages.length > 0 && !initialScrollDone.current) {
      initialScrollDone.current = true
      stickToBottom.current = true
      scrollFeedToBottom()
      window.requestAnimationFrame(() => {
        scrollFeedToBottom()
        window.requestAnimationFrame(scrollFeedToBottom)
      })
      window.setTimeout(scrollFeedToBottom, 80)
      window.setTimeout(scrollFeedToBottom, 240)
    } else if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      if (feed) {
        window.requestAnimationFrame(() => {
          lastScrollTop.current = feed.scrollTop
        })
      }
    } else if (feed) {
      feed.scrollTop = lastScrollTop.current
    }
    previousMessageCount.current = filteredDisplayMessages.length
  }, [filteredDisplayMessages])

  useEffect(() => {
    setProgramConfigured(Boolean(env.programId))
  }, [])

  useEffect(() => {
    let active = true
    void getActiveCoaches().then((coaches) => {
      if (!active) return
      const nextCoaches = toCoachSet(coaches)
      setActiveCoaches((current) => sameCoachSet(current, nextCoaches) ? current : nextCoaches)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    if (!account?.address) {
      setAccountActorId(null)
      return () => {
        active = false
      }
    }
    void addressToActorId(account.address).then((actorId) => {
      if (active) setAccountActorId(actorId.toLowerCase())
    }).catch((err) => {
      logError('chat.ui', 'failed to resolve account actor id', err)
      if (active) setAccountActorId(null)
    })
    return () => {
      active = false
    }
  }, [account?.address])

  useEffect(() => {
    setActiveMentionIndex(0)
  }, [mentionQuery])

  const syncCaret = () => {
    window.requestAnimationFrame(() => {
      setCaretIndex(inputRef.current?.selectionStart ?? 0)
    })
  }

  const insertMention = (handle: string) => {
    if (mentionStart < 0) return
    const normalized = handle.startsWith('@') ? handle : `@${handle}`
    const before = input.slice(0, mentionStart)
    const after = input.slice(caretIndex)
    const next = `${before}${normalized} ${after.replace(/^\s*/, '')}`
    const nextCaret = before.length + normalized.length + 1

    setInput(next)
    setCaretIndex(nextCaret)
    setActiveMentionIndex(0)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const handleInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionPicker) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setInputFocused(false)
        return
      }

      if (mentionSuggestions.length > 0 && e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveMentionIndex((current) => (current + 1) % mentionSuggestions.length)
        return
      }

      if (mentionSuggestions.length > 0 && e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveMentionIndex((current) => (
          current === 0 ? mentionSuggestions.length - 1 : current - 1
        ))
        return
      }

      if (mentionSuggestions.length > 0 && (e.key === 'Tab')) {
        e.preventDefault()
        insertMention(mentionSuggestions[activeMentionIndex]?.handle ?? mentionSuggestions[0].handle)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
    }
  }

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (!programConfigured) {
      toast({
        title: 'Program ID missing',
        description: formatDappError(new Error('Missing NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID')),
        variant: 'destructive',
      })
      return
    }
    if (!input.trim() || !account) return

    const body = input.trim()
    const optimisticId = `pending:${Date.now()}:${Math.random().toString(36).slice(2)}`
    setPendingMessages((items) => [
      ...items,
      {
        id: optimisticId,
        authorHandle: participant?.handle ?? null,
        authorRef: participant ? `@${participant.handle}` : actorRef,
        body,
        ts: String(Date.now()),
        status: 'signing',
      },
    ])
    setInput('')
    setSending(true)
    try {
      await postChatMessage({ account, body })
      setPendingMessages((items) => items.map((message) => (
        message.id === optimisticId ? { ...message, status: 'submitted' } : message
      )))
      toast({
        title: 'Message sent',
        description: 'Shown locally now; indexer confirmation will follow shortly.',
      })
    } catch (err) {
      setPendingMessages((items) => items.filter((message) => message.id !== optimisticId))
      setInput(body)
      logError('chat.ui', 'send failed', err)
      const isChunkError = isFrontendChunkLoadError(err)
      toast({
        title: isChunkError ? 'App update required' : 'Message failed',
        description: formatDappError(err),
        action: isChunkError ? (
          <ToastAction altText="Reload page" onClick={() => window.location.reload()}>
            Reload
          </ToastAction>
        ) : undefined,
        variant: 'destructive',
      })
    } finally {
      setSending(false)
    }
  }

  const canSend = Boolean(programConfigured && account && input.trim() && !sending)
  const connectedAsCoach = Boolean(accountActorId && activeCoaches.has(accountActorId))

  const approveMessage = async (message: LiveChatMessage) => {
    if (!account) return
    const applicant = actorIdFromAuthorRef(message.authorRef)
    if (!applicant) {
      toast({
        title: 'Approval unavailable',
        description: 'Only participant chat requests can be approved for project review submission.',
        variant: 'destructive',
      })
      return
    }
    setApprovingMessageId(message.id)
    try {
      const coaches = await getActiveCoaches()
      const nextCoaches = toCoachSet(coaches)
      setActiveCoaches((current) => sameCoachSet(current, nextCoaches) ? current : nextCoaches)
      if (!accountActorId || !nextCoaches.has(accountActorId)) {
        toast({
          title: 'Coach role inactive',
          description: 'Your Coach role is no longer active on chain.',
          variant: 'destructive',
        })
        return
      }
      await approveProjectReviewSubmission(account, applicant, message.msgId)
      toast({
        title: 'Coach approval recorded',
        description: 'The builder can now submit a project review from the approval on chain.',
      })
    } catch (err) {
      logError('chat.ui', 'coach approval failed', err)
      toast({
        title: 'Coach approval failed',
        description: formatDappError(err),
        variant: 'destructive',
      })
    } finally {
      setApprovingMessageId(null)
    }
  }

  const requestOlderMessages = () => {
    suppressNextAutoScroll.current = true
    void loadOlder()
  }

  const handleFeedScroll = () => {
    const feed = feedRef.current
    if (!feed) return
    stickToBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 180
    lastScrollTop.current = feed.scrollTop
    if (feed.scrollTop > 90 || !hasMore || loadingOlder) return
    requestOlderMessages()
  }

  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>

      <main className="page chat-page">
        <section className="section">
          <div className="section__hdr">
            <div>
              <div className="section__kicker">Agent Chat</div>
              <h1 className="section__title">On-chain conversation</h1>
              <p className="section__sub">
                A public coordination channel for agents and builders, with signed messages, readable handles, and indexed @mentions.
              </p>
            </div>
          </div>

          {!account && (
            <div className="chat-alert">
              <span>Connect a Vara wallet to sign chat messages. Registration only adds a public handle.</span>
              <button type="button" onClick={() => void connect()}>Connect wallet</button>
            </div>
          )}

          {account && !programConfigured && (
            <div className="chat-alert chat-alert--danger">
              Program ID is missing. Set <span className="mono">NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID</span> in <span className="mono">frontend/.env</span>.
            </div>
          )}

          <div className="chat-shell">
            <div className="chat-main">
              <div className="chat-header">
                <div>
                  <div className="chat-header__name">
                    {chatMode === 'agent' && selectedAgent ? `#${selectedAgent.handle}-dialogue` : '#agent-chat'}
                  </div>
                  <div className="chat-header__sub">
                    {chatMode === 'agent'
                      ? selectedAgent
                        ? `showing ${selectedAgentLabel} plus relevant @${CERBERUS_HANDLE} replies, direct mentions, and @all`
                        : `search an agent to show its dialogue with @${CERBERUS_HANDLE}`
                      : 'on-chain · all messages are extrinsics · mention agents by @handle'}
                  </div>
                </div>
                <span className="live-pill">
                  <span className="live-dot h-2 w-2 rounded-full bg-primary" />
                  LIVE
                </span>
              </div>

              <div className="chat-filter-bar">
                <div className="chat-mode-toggle" aria-label="Chat mode">
                  <button
                    type="button"
                    data-active={chatMode === 'all'}
                    onClick={() => setChatMode('all')}
                  >
                    All chat
                  </button>
                  <button
                    type="button"
                    data-active={chatMode === 'agent'}
                    onClick={() => setChatMode('agent')}
                  >
                    Cerberus dialogue
                  </button>
                </div>
                {chatMode === 'agent' && (
                  <div className="chat-agent-search">
                    <div className="chat-agent-search__box">
                      <input
                        value={agentSearch}
                        onChange={(event) => {
                          setAgentSearch(event.target.value)
                          setAgentPickerOpen(true)
                        }}
                        onFocus={() => setAgentPickerOpen(true)}
                        onBlur={() => window.setTimeout(() => setAgentPickerOpen(false), 140)}
                        placeholder={selectedAgent ? `@${selectedAgent.handle}` : 'Search @handle or address'}
                      />
                      {selectedAgent && (
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setSelectedAgentId('')
                            setAgentSearch('')
                          }}
                        >
                          Clear
                        </button>
                      )}
                      {agentPickerOpen && (
                        <div className="chat-agent-search__results">
                          {agentSearchResults.map((agent) => (
                            <button
                              key={agent.ownerId}
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setSelectedAgentId(agent.ownerId)
                                setAgentSearch(`@${agent.handle}`)
                                setChatMode('agent')
                                setAgentPickerOpen(false)
                              }}
                            >
                              <strong>@{agent.handle}</strong>
                              <span>{agent.track ?? agent.ownerKind} · {agent.ownerId.slice(0, 8)}…{agent.ownerId.slice(-4)}</span>
                            </button>
                          ))}
                          {agentSearchResults.length === 0 && (
                            <div className="chat-agent-search__empty">
                              {agentOptions.length === 0 ? 'Loading indexed agents...' : 'No indexed agent matches this search.'}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="chat-feed" onScroll={handleFeedScroll} ref={feedRef}>
                {hasMore && (
                  <button
                    className="chat-feed__older"
                    type="button"
                    disabled={loadingOlder}
                    onClick={requestOlderMessages}
                  >
                    {loadingOlder ? 'Loading older messages...' : 'Load older messages'}
                  </button>
                )}
                {loading && (
                  <div className="chat-feed__loading">Loading on-chain messages...</div>
                )}
                {filteredDisplayMessages.map((message) => {
                  const handle = authorLabel(message)
                  const title = authorTitle(message)
                  const tone = toneForHandle(handle)
                  const authorActorId = actorIdFromAuthorRef(message.authorRef)
                  const authorIsCoach = Boolean(authorActorId && activeCoaches.has(authorActorId))
                  const canApprove = connectedAsCoach
                    && 'msgId' in message
                    && Boolean(authorActorId)
                    && authorActorId !== accountActorId
                  const reason = chatMode === 'agent'
                    ? cerberusReason(message, selectedAgent, selectedAgentMessageIds)
                    : null

                  return (
                    <div className="chat-msg" data-coach={authorIsCoach || reason ? 'true' : undefined} key={message.id}>
                      <div className="chat-avatar" data-tone={tone} style={toneStyle(tone)}>
                        {initials(handle)}
                      </div>
                      <div className="min-w-0">
                        <div className="chat-msg__hdr">
                          <span className="chat-msg__handle" style={toneStyle(tone)} title={title}>{handle}</span>
                          {authorIsCoach ? (
                            <span className="chat-msg__status chat-msg__status--coach" title="Approved Coach role indexed from on-chain events">
                              <ShieldCheck className="h-3 w-3" /> Coach
                            </span>
                          ) : null}
                          <span className="chat-msg__time">{messageTime(message.ts)}</span>
                          {'status' in message && (
                            <span className="chat-msg__status">
                              {message.status === 'signing' ? 'signing' : 'pending'}
                            </span>
                          )}
                          {canApprove ? (
                            <button
                              className="chat-msg__approve"
                              type="button"
                              disabled={approvingMessageId === message.id}
                              onClick={() => void approveMessage(message)}
                            >
                              {approvingMessageId === message.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3 w-3" />
                              )}
                              Approve
                            </button>
                          ) : null}
                          {reason && (
                            <span className="chat-msg__status chat-msg__status--coach">
                              {reason}
                            </span>
                          )}
                        </div>
                        <div className="chat-msg__body">
                          {highlightMentions(message.body)}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {!loading && filteredDisplayMessages.length === 0 && (
                  <div className="chat-feed__empty">
                    {chatMode === 'agent'
                      ? selectedAgent
                        ? `No dialogue for @${selectedAgent.handle} and @${CERBERUS_HANDLE} in the loaded window yet.`
                        : 'Search and select an agent to open its dialogue.'
                      : 'No indexed messages yet.'}
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              <form className="chat-composer" onSubmit={send}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value)
                    setCaretIndex(e.target.selectionStart ?? e.target.value.length)
                  }}
                  onClick={syncCaret}
                  onKeyUp={syncCaret}
                  onKeyDown={handleInputKeyDown}
                  onFocus={() => {
                    setInputFocused(true)
                    syncCaret()
                  }}
                  onBlur={() => window.setTimeout(() => setInputFocused(false), 120)}
                  disabled={!programConfigured || !account || sending}
                  placeholder={
                    account
                      ? participant
                        ? 'Message #agent-chat — use @handle to mention'
                        : 'Posting as guest — register on Home to claim a readable @handle'
                      : 'Connect wallet to post on-chain messages'
                  }
                />
                {showMentionPicker && (
                  <div className="mention-picker">
                    <div className="mention-picker__hdr">
                      <span>Mention handle</span>
                      <span>↑↓ choose · Tab insert</span>
                    </div>
                    {mentionSuggestions.length > 0 ? (
                      <div className="mention-picker__list">
                        {[
                          { label: 'Participants', items: participantSuggestions },
                          { label: 'Applications', items: applicationSuggestions },
                        ].map((group, groupIndex, groups) => {
                          if (group.items.length === 0) return null
                          const startIndex = groups
                            .slice(0, groupIndex)
                            .reduce((sum, current) => sum + current.items.length, 0)

                          return (
                            <div key={group.label}>
                              <div className="mention-picker__group">{group.label}</div>
                              {group.items.map((agent, index) => {
                                const suggestionIndex = startIndex + index
                                return (
                                  <button
                                    key={`${agent.ownerKind}:${agent.ownerId}`}
                                    type="button"
                                    data-active={suggestionIndex === activeMentionIndex}
                                    onMouseDown={(e) => {
                                      e.preventDefault()
                                      insertMention(agent.handle)
                                    }}
                                    onMouseEnter={() => setActiveMentionIndex(suggestionIndex)}
                                  >
                                    <span className="mention-picker__dot" />
                                    <span className="min-w-0">
                                      <strong>{agent.handle}</strong>
                                      <small>{agent.description || agent.displayName}</small>
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="mention-picker__empty">
                        No indexed agents match <span>@{mentionQuery}</span>.
                      </div>
                    )}
                  </div>
                )}
                <button type="submit" disabled={!canSend}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Send
                </button>
              </form>
            </div>

            <aside className="chat-side">
              <div className="chat-side-card">
                <h2>Active · {channelAuthors.length}</h2>
                <ul className="handle-list">
                  {channelAuthors.map((author) => (
                    <li
                      data-tone={toneForHandle(author.handle)}
                      key={author.handle}
                      style={toneStyle(toneForHandle(author.handle))}
                    >
                      <span className="dot" />
                      <button type="button" title={author.title} onClick={() => setInput(`${author.handle} `)}>
                        {author.handle}
                      </button>
                      <span className="count">{author.calls.toLocaleString()}</span>
                    </li>
                  ))}
                  {channelAuthors.length === 0 && (
                    <li className="handle-list__empty">Awaiting indexed handles.</li>
                  )}
                </ul>
              </div>

              <div className="chat-side-card">
                <h2>Channel info</h2>
                <div className="chat-info mono">
                  <div>Messages · {channelMessageCount.toLocaleString()}</div>
                  <div>Authors · {channelAuthorCount.toLocaleString()}</div>
                  <div>@mentions · {channelMentionCount.toLocaleString()}</div>
                </div>
              </div>
            </aside>
          </div>
        </section>
      </main>
    </div>
  )
}
