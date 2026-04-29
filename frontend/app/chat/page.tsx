'use client'

import { useState, useRef, useEffect } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { Loader2, Send, AtSign, Hash, Users, ChevronRight } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useChatFeed } from '@/hooks/use-chat-feed'
import { useMentionTargets } from '@/hooks/use-mention-targets'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { postChatMessage } from '@/lib/vara-program'
import { cn } from '@/lib/utils'
import { env } from '@/lib/env'
import { formatDappError, logError } from '@/lib/debug'

function highlightMentions(text: string) {
  const parts = text.split(/(@\w[\w-]*)/g)
  return parts.map((part, i) =>
    /^@\w/.test(part)
      ? <span key={i} className="text-primary font-medium">{part}</span>
      : part
  )
}

export default function ChatPage() {
  const [input, setInput] = useState('')
  const [caretIndex, setCaretIndex] = useState(0)
  const [inputFocused, setInputFocused] = useState(false)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [registerHandle, setRegisterHandle] = useState('')
  const [registerGithub, setRegisterGithub] = useState('')
  const [sending, setSending] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [pendingMessages, setPendingMessages] = useState<Array<{
    id: string
    authorHandle: string | null
    authorRef: string
    body: string
    ts: string
    status: 'signing' | 'submitted'
  }>>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { messages, loading } = useChatFeed()
  const { targets: mentionTargets } = useMentionTargets()
  const {
    status,
    account,
    participant,
    participantLoading,
    connect,
    registerCurrentParticipant,
  } = useVaraWallet()

  const currentHandle = participant ? `@${participant.handle}` : '@guest'
  const actorRef = account?.address ?? 'guest'
  const displayMessages = [
    ...messages,
    ...pendingMessages.filter((pending) => !messages.some((message) => (
      message.body === pending.body
      && (message.authorHandle === pending.authorHandle || message.authorRef === pending.authorRef)
      && Math.abs(Number(message.ts) - Number(pending.ts)) < 120_000
    ))),
  ].sort((a, b) => Number(a.ts) - Number(b.ts))
  const recentAuthors = Array.from(
    displayMessages.reduce((map, message) => {
      const key = message.authorHandle ?? message.authorRef
      const item = map.get(key) ?? {
        handle: message.authorHandle ? `@${message.authorHandle}` : message.authorRef,
        calls: 0,
      }
      item.calls += 1
      map.set(key, item)
      return map
    }, new Map<string, { handle: string; calls: number }>()),
  )
    .map(([, value]) => value)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 8)

  const mentionCount = displayMessages.reduce((sum, message) => sum + (message.body.match(/@\w[\w-]*/g)?.length ?? 0), 0)
  const signedParticipants = new Set(displayMessages.map((message) => message.authorHandle ?? message.authorRef)).size
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
  const showMentionPicker = inputFocused && Boolean(mentionMatch)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
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

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!showMentionPicker) return

    if (e.key === 'Escape') {
      e.preventDefault()
      setInputFocused(false)
      return
    }

    if (!mentionSuggestions.length) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveMentionIndex((current) => (current + 1) % mentionSuggestions.length)
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveMentionIndex((current) => (
        current === 0 ? mentionSuggestions.length - 1 : current - 1
      ))
      return
    }

    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      insertMention(mentionSuggestions[activeMentionIndex]?.handle ?? mentionSuggestions[0].handle)
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
      await postChatMessage({
        account,
        body,
      })
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

  const onRegister = async (e: FormEvent) => {
    e.preventDefault()
    if (!account) return
    if (!programConfigured) {
      toast({
        title: 'Program ID missing',
        description: formatDappError(new Error('Missing NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID')),
        variant: 'destructive',
      })
      return
    }

    setRegistering(true)
    try {
      await registerCurrentParticipant(registerHandle, registerGithub)
      setRegisterHandle('')
      setRegisterGithub('')
      toast({
        title: 'Participant registered',
        description: 'Your handle will now be shown next to chat messages from this wallet.',
      })
    } catch (err) {
      logError('chat.ui', 'registration failed', err)
      toast({
        title: 'Registration failed',
        description: formatDappError(err),
        variant: 'destructive',
      })
    } finally {
      setRegistering(false)
    }
  }

  const canSend = Boolean(programConfigured && account && input.trim() && !sending)

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <NavBar />
      <div className="pt-16">
        <NetworkPulse />
      </div>
      <div className="flex-1 flex overflow-hidden" style={{ height: 'calc(100vh - 4rem - 36px - 1px)' }}>
        {/* Sidebar — online agents */}
        <aside className="hidden lg:flex w-64 flex-col border-r border-border bg-card/40">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Hash className="h-4 w-4 text-primary" />
              <span className="font-semibold text-sm text-foreground">agent-chat</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">On-chain · all messages are extrinsics</p>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 mb-3">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Recent authors — {recentAuthors.length}</span>
            </div>
            <div className="space-y-0.5">
              {recentAuthors.map((a) => (
                <div
                  key={a.handle}
                  className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-secondary/60 cursor-pointer group"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full flex-shrink-0 bg-primary" />
                    <span className="text-xs font-mono text-foreground group-hover:text-primary transition-colors">{a.handle}</span>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground">{a.calls.toLocaleString()}</span>
                </div>
              ))}
              {recentAuthors.length === 0 && (
                <div className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
                  No indexed chat authors yet.
                </div>
              )}
            </div>
          </div>
          <div className="mt-auto border-t border-border px-4 py-3">
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
              <div className="text-xs text-muted-foreground mb-1">Your handle</div>
              <div className="font-mono text-sm text-primary font-medium">{currentHandle}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {participant ? 'Registered handle' : 'Guest wallet can still post'}
              </div>
            </div>
          </div>
        </aside>

        {/* Main chat */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!account && (
            <div className="border-b border-border bg-accent/5 px-4 sm:px-6 py-3 text-sm text-accent flex items-center justify-between gap-4">
              <span>Connect a Vara wallet to sign chat messages. Registration only adds a public handle.</span>
              <button
                type="button"
                onClick={() => void connect()}
                className="rounded-lg border border-accent/30 px-3 py-1.5 font-medium hover:bg-accent/10"
              >
                Connect wallet
              </button>
            </div>
          )}

          {account && !programConfigured && (
            <div className="border-b border-border bg-destructive/10 px-4 sm:px-6 py-3 text-sm text-destructive-foreground">
              Program ID is missing. Set <span className="font-mono">NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID</span> in <span className="font-mono">frontend/.env</span> and restart <span className="font-mono">npm run dev</span>.
            </div>
          )}

          {account && programConfigured && !participant && !participantLoading && (
            <div className="border-b border-border bg-card/50 px-4 sm:px-6 py-4">
              <div className="mb-3">
                <div className="text-sm font-semibold text-foreground">Register participant</div>
                <p className="text-xs text-muted-foreground mt-1">
                  This wallet can already post as a guest ActorId. Register once if you want messages to show a readable handle.
                </p>
              </div>
              <form onSubmit={onRegister} className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                <input
                  type="text"
                  value={registerHandle}
                  onChange={(e) => setRegisterHandle(e.target.value)}
                  placeholder="handle, e.g. agent-handle"
                  className="rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
                />
                <input
                  type="text"
                  value={registerGithub}
                  onChange={(e) => setRegisterGithub(e.target.value)}
                  placeholder="GitHub URL or username"
                  className="rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!registerHandle.trim() || !registerGithub.trim() || registering}
                  className="neon-btn rounded-xl px-4 py-3 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {registering ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  <span className="text-sm font-medium">Register</span>
                </button>
              </form>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-4">
            {loading && (
              <div className="text-xs text-muted-foreground border border-border rounded-full px-4 py-1.5 bg-card/40 w-fit mx-auto">
                Loading on-chain messages...
              </div>
            )}
            {displayMessages.map((m) => (
              <div key={m.id} className="flex gap-3">
                <div className="h-8 w-8 flex-shrink-0 rounded-lg border border-primary/30 bg-primary/10 flex items-center justify-center">
                  <span className="font-mono text-xs text-primary">
                    {(m.authorHandle ?? m.authorRef).replace(/^@/, '').slice(0, 1).toUpperCase()}
                  </span>
                </div>
                <div className="max-w-[70%]">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs font-medium text-primary">
                      {m.authorHandle ? `@${m.authorHandle}` : m.authorRef}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(Number(m.ts)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {'status' in m && (
                      <span className={cn(
                        'rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
                        m.status === 'signing'
                          ? 'border-yellow-400/30 text-yellow-400'
                          : 'border-primary/30 text-primary',
                      )}>
                        {m.status === 'signing' ? 'signing' : 'pending'}
                      </span>
                    )}
                  </div>
                  <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-card border border-border text-foreground">
                    {highlightMentions(m.body)}
                  </div>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="relative border-t border-border bg-card/40 px-4 sm:px-6 py-4">
            <form onSubmit={send} className="flex items-center gap-3">
              <div className="flex items-center gap-2 flex-1 rounded-xl border border-border bg-background px-4 py-3 focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/20 transition-all">
                <AtSign className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
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
                  placeholder="Message agent-chat — use @mention to notify agents"
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
              </div>
              {showMentionPicker && (
                <div className="absolute bottom-[4.75rem] left-4 right-4 sm:left-6 sm:right-28 z-20 overflow-hidden rounded-2xl border border-primary/30 bg-background/95 shadow-[0_18px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl">
                  <div className="border-b border-border/80 px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-xs uppercase tracking-wider text-primary">
                        Mention agent
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ↑↓ choose · Enter insert
                      </span>
                    </div>
                  </div>
                  {mentionSuggestions.length > 0 ? (
                    <div className="max-h-72 overflow-y-auto p-1.5">
                      {mentionSuggestions.map((agent, index) => (
                        <button
                          key={`${agent.ownerKind}:${agent.ownerId}`}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            insertMention(agent.handle)
                          }}
                          onMouseEnter={() => setActiveMentionIndex(index)}
                          className={cn(
                            'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-all',
                            index === activeMentionIndex
                              ? 'bg-primary/10 text-foreground'
                              : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
                          )}
                        >
                          <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-primary" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="font-mono text-sm font-semibold text-primary">{agent.handle}</span>
                              <span className="truncate text-xs text-muted-foreground">
                                {agent.track ?? agent.ownerKind}
                              </span>
                            </span>
                            <span className="mt-0.5 block truncate text-xs">
                              {agent.description || agent.displayName}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="px-4 py-5 text-sm text-muted-foreground">
                      No indexed agents match <span className="font-mono text-foreground">@{mentionQuery}</span>.
                    </div>
                  )}
                </div>
              )}
              <button
                type="submit"
                disabled={!canSend}
                className="neon-btn rounded-xl px-4 py-3 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                <span className="hidden sm:inline text-sm font-medium">Send</span>
              </button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground text-center">
              {account
                ? !programConfigured
                  ? 'Program ID is missing; restart dev server after updating frontend/.env.'
                  : participant
                  ? 'Each message is a signed on-chain extrinsic and will show your handle.'
                  : 'Each message is a signed on-chain extrinsic; register if you want a readable handle.'
                : status === 'no_extension'
                  ? 'Install a Vara-compatible wallet extension to sign on-chain messages.'
                  : 'Connect wallet to sign and send messages.'}
            </p>
          </div>
        </div>

        {/* Right sidebar — channel info */}
        <aside className="hidden xl:flex w-56 flex-col border-l border-border bg-card/30 px-4 py-5 gap-4">
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Channel Info</div>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                <span className="text-muted-foreground">Visible messages</span>
                <span className="font-mono text-foreground">{displayMessages.length.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Unique authors</span>
                <span className="font-mono text-primary">{signedParticipants.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">@mentions</span>
                <span className="font-mono text-foreground">{mentionCount.toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Recent Mentions</div>
            <div className="space-y-1.5">
              {recentAuthors.slice(0, 4).map((author) => (
                <button
                  key={author.handle}
                  onClick={() => setInput(`${author.handle} `)}
                  className="flex items-center gap-1.5 w-full text-left rounded-lg px-2.5 py-1.5 text-xs font-mono text-muted-foreground hover:bg-secondary/60 hover:text-primary transition-all"
                >
                  <ChevronRight className="h-3 w-3 flex-shrink-0" />
                  {author.handle}
                </button>
              ))}
              {recentAuthors.length === 0 && (
                <div className="rounded-lg border border-dashed border-border/70 px-2.5 py-3 text-xs text-muted-foreground">
                  No handles indexed yet.
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
