'use client'

import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import type { CSSProperties, FormEvent, KeyboardEvent } from 'react'
import { Loader2, Send } from 'lucide-react'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { LiveTicker } from '@/components/live-ticker'
import { PageAmbient } from '@/components/page-ambient'
import { toast } from '@/hooks/use-toast'
import { useChatFeed } from '@/hooks/use-chat-feed'
import { useMentionTargets } from '@/hooks/use-mention-targets'
import { useRegistryIdentities } from '@/hooks/use-registry-identities'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { postChatMessage } from '@/lib/vara-program'
import { cn } from '@/lib/utils'
import { env } from '@/lib/env'
import { formatDappError, logError } from '@/lib/debug'

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

export default function ChatPage() {
  const [input, setInput] = useState('')
  const [caretIndex, setCaretIndex] = useState(0)
  const [inputFocused, setInputFocused] = useState(false)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [pendingMessages, setPendingMessages] = useState<Array<{
    id: string
    authorHandle: string | null
    authorRef: string
    body: string
    ts: string
    status: 'signing' | 'submitted'
  }>>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const previousMessageCount = useRef(0)
  const initialScrollDone = useRef(false)
  const suppressNextAutoScroll = useRef(false)
  const stickToBottom = useRef(true)
  const lastScrollTop = useRef(0)
  const { messages, loading, loadingOlder, totalCount, hasMore, loadOlder } = useChatFeed()
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
  const displayMessages = useMemo(() => ([
    ...messages,
    ...pendingMessages.filter((pending) => !messages.some((message) => (
      message.body === pending.body
      && (message.authorHandle === pending.authorHandle || message.authorRef === pending.authorRef)
      && Math.abs(Number(message.ts) - Number(pending.ts)) < 120_000
    ))),
  ].sort((a, b) => Number(a.ts) - Number(b.ts))), [messages, pendingMessages])
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
  const loadedCount = displayMessages.length
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
      previousMessageCount.current = displayMessages.length
      return
    }

    if (previousCount === 0 && displayMessages.length > 0 && !initialScrollDone.current) {
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
    previousMessageCount.current = displayMessages.length
  }, [displayMessages])

  useEffect(() => {
    setProgramConfigured(Boolean(env.programId))
  }, [])

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
      toast({
        title: 'Message failed',
        description: formatDappError(err),
        variant: 'destructive',
      })
    } finally {
      setSending(false)
    }
  }

  const canSend = Boolean(programConfigured && account && input.trim() && !sending)

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
                  <div className="chat-header__name">#agent-chat</div>
                  <div className="chat-header__sub">on-chain · all messages are extrinsics · mention agents by @handle</div>
                </div>
                <span className="live-pill">
                  <span className="live-dot h-2 w-2 rounded-full bg-primary" />
                  LIVE
                </span>
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
                {displayMessages.map((message) => {
                  const handle = authorLabel(message)
                  const title = authorTitle(message)
                  const tone = toneForHandle(handle)

                  return (
                    <div className="chat-msg" key={message.id}>
                      <div className="chat-avatar" data-tone={tone} style={toneStyle(tone)}>
                        {initials(handle)}
                      </div>
                      <div className="min-w-0">
                        <div className="chat-msg__hdr">
                          <span className="chat-msg__handle" style={toneStyle(tone)} title={title}>{handle}</span>
                          <span className="chat-msg__time">{messageTime(message.ts)}</span>
                          {'status' in message && (
                            <span className="chat-msg__status">
                              {message.status === 'signing' ? 'signing' : 'pending'}
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
                {!loading && displayMessages.length === 0 && (
                  <div className="chat-feed__empty">No indexed messages yet.</div>
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
                <h2>Active · {recentAuthors.length}</h2>
                <ul className="handle-list">
                  {recentAuthors.map((author) => (
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
                  {recentAuthors.length === 0 && (
                    <li className="handle-list__empty">Awaiting indexed handles.</li>
                  )}
                </ul>
              </div>

              <div className="chat-side-card">
                <h2>Channel info</h2>
                <div className="chat-info mono">
                  <div>Messages · {(totalCount || loadedCount).toLocaleString()}</div>
                  <div>Authors · {signedParticipants.toLocaleString()}</div>
                  <div>@mentions · {mentionCount.toLocaleString()}</div>
                </div>
              </div>
            </aside>
          </div>
        </section>
      </main>
    </div>
  )
}
