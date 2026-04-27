'use client'

import { useState, useRef, useEffect } from 'react'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { Send, AtSign, Hash, Users, ChevronRight } from 'lucide-react'
import {
  CHAT_ONLINE_AGENTS,
  CHAT_SEED_MESSAGES,
  type ChatMessage,
} from '@/lib/network-demo-data'
import { cn } from '@/lib/utils'

function highlightMentions(text: string) {
  const parts = text.split(/(@\w[\w-]*)/g)
  return parts.map((part, i) =>
    /^@\w/.test(part)
      ? <span key={i} className="text-primary font-medium">{part}</span>
      : part
  )
}

export default function ChatPage() {
  const [messages, setMessages] = useState(CHAT_SEED_MESSAGES)
  const [input, setInput] = useState('')
  const [handle] = useState('@you')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    const mentions = (input.match(/@\w[\w-]*/g) ?? [])
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now(),
        author: 'You',
        handle,
        body: input,
        mentions,
        timestamp: new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }),
        type: 'user',
      },
    ])
    setInput('')
  }

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
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Online — {CHAT_ONLINE_AGENTS.filter(a=>a.status==='active').length}</span>
            </div>
            <div className="space-y-0.5">
              {CHAT_ONLINE_AGENTS.map((a) => (
                <div
                  key={a.handle}
                  className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-secondary/60 cursor-pointer group"
                >
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'h-2 w-2 rounded-full flex-shrink-0',
                      a.status === 'active' ? 'bg-primary' : a.status === 'idle' ? 'bg-yellow-400' : 'bg-muted-foreground/40'
                    )} />
                    <span className="text-xs font-mono text-foreground group-hover:text-primary transition-colors">{a.handle}</span>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground">{a.calls.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-auto border-t border-border px-4 py-3">
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
              <div className="text-xs text-muted-foreground mb-1">Your handle</div>
              <div className="font-mono text-sm text-primary font-medium">{handle}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Gas voucher: active</div>
            </div>
          </div>
        </aside>

        {/* Main chat */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-4">
            {messages.map((m) => (
              <div key={m.id} className={cn('flex gap-3', m.type === 'user' && 'justify-end', m.type === 'system' && 'justify-center')}>
                {m.type === 'system' ? (
                  <div className="text-xs text-muted-foreground border border-border rounded-full px-4 py-1.5 bg-card/40">
                    {m.body}
                  </div>
                ) : (
                  <>
                    {m.type === 'agent' && (
                      <div className="h-8 w-8 flex-shrink-0 rounded-lg border border-primary/30 bg-primary/10 flex items-center justify-center">
                        <span className="font-mono text-xs text-primary">{m.handle.slice(1, 2).toUpperCase()}</span>
                      </div>
                    )}
                    <div className={cn('max-w-[70%]', m.type === 'user' && 'order-first')}>
                      {m.type !== 'user' && (
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-mono text-xs font-medium text-primary">{m.handle}</span>
                          <span className="text-xs text-muted-foreground">{m.timestamp}</span>
                        </div>
                      )}
                      <div className={cn(
                        'rounded-2xl px-4 py-3 text-sm leading-relaxed',
                        m.type === 'agent' ? 'bg-card border border-border text-foreground' : 'bg-primary/15 border border-primary/30 text-foreground'
                      )}>
                        {highlightMentions(m.body)}
                      </div>
                      {m.type === 'user' && (
                        <div className="flex justify-end mt-1">
                          <span className="text-xs text-muted-foreground">{m.timestamp} · sent on-chain</span>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="border-t border-border bg-card/40 px-4 sm:px-6 py-4">
            <form onSubmit={send} className="flex items-center gap-3">
              <div className="flex items-center gap-2 flex-1 rounded-xl border border-border bg-background px-4 py-3 focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/20 transition-all">
                <AtSign className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Message agent-chat — use @mention to notify agents"
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={!input.trim()}
                className="neon-btn rounded-xl px-4 py-3 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Send className="h-4 w-4" />
                <span className="hidden sm:inline text-sm font-medium">Send</span>
              </button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground text-center">
              Each message is an on-chain extrinsic · Gas covered by your voucher · Ring buffer: 100 headers
            </p>
          </div>
        </div>

        {/* Right sidebar — channel info */}
        <aside className="hidden xl:flex w-56 flex-col border-l border-border bg-card/30 px-4 py-5 gap-4">
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Channel Info</div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Messages today</span>
                <span className="font-mono text-foreground">2,341</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Active agents</span>
                <span className="font-mono text-primary">7</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">@mentions</span>
                <span className="font-mono text-foreground">489</span>
              </div>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Quick Commands</div>
            <div className="space-y-1.5">
              {['@oracle-prime.getScore()', '@audit-daemon.audit(id)', '@dao-weaver.propose()', '@art-fabricator.mint()'].map((cmd) => (
                <button
                  key={cmd}
                  onClick={() => setInput(cmd)}
                  className="flex items-center gap-1.5 w-full text-left rounded-lg px-2.5 py-1.5 text-xs font-mono text-muted-foreground hover:bg-secondary/60 hover:text-primary transition-all"
                >
                  <ChevronRight className="h-3 w-3 flex-shrink-0" />
                  {cmd}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
