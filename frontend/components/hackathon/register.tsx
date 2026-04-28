'use client'

import { useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, Github, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { toast } from '@/hooks/use-toast'
import { env } from '@/lib/env'
import { formatDappError, logError } from '@/lib/debug'
import { isGithubUrl } from '@/lib/vara-program'

export function RegisterSection() {
  const [handle, setHandle] = useState('')
  const [github, setGithub] = useState('')
  const [selectedTrack, setSelectedTrack] = useState('Agent Services')
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [programConfigured, setProgramConfigured] = useState(true)
  const { account, participant, connect, registerCurrentParticipant } = useVaraWallet()

  useEffect(() => {
    setProgramConfigured(Boolean(env.programId))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!programConfigured) {
      toast({
        title: 'Program ID missing',
        description: formatDappError(new Error('Missing NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID')),
        variant: 'destructive',
      })
      return
    }

    if (!account) {
      await connect()
      toast({
        title: 'Connect wallet first',
        description: 'Your wallet must be connected so the registration can be signed on-chain.',
      })
      return
    }

    if (participant) {
      setDone(true)
      return
    }

    if (!isGithubUrl(github)) {
      toast({
        title: 'Invalid GitHub URL',
        description: 'GitHub repository URL must start with https://github.com/',
        variant: 'destructive',
      })
      return
    }

    setSubmitting(true)
    try {
      await registerCurrentParticipant(handle, github)
      setDone(true)
      toast({
        title: 'Registration submitted',
        description: 'Your participant registration was signed and sent on-chain.',
      })
    } catch (err) {
      logError('hackathon.registration', 'participant registration failed', err, {
        account: account.address,
        handle,
        selectedTrack,
      })
      toast({
        title: 'Registration failed',
        description: formatDappError(err),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="py-24 bg-card/20" id="register">
      <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10">
          <div className="inline-block font-mono text-xs text-primary border border-primary/30 bg-primary/5 rounded-full px-3 py-1 mb-4">
            REGISTRATION
          </div>
          <h2 className="text-4xl sm:text-5xl font-bold mb-4">
            Claim your <span className="gradient-text">handle</span>
          </h2>
          <p className="text-muted-foreground">
            Chat works with any connected wallet; registration claims the readable handle shown next to your messages.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card/80 backdrop-blur p-8">
          {done ? (
            <div className="text-center py-8">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-primary/40 bg-primary/10">
                <CheckCircle2 className="h-8 w-8 text-primary" />
              </div>
              <div className="font-mono text-xl font-bold text-primary mb-2">@{handle || 'agent'}</div>
              <div className="text-foreground font-semibold mb-1">You&apos;re registered!</div>
              <div className="text-muted-foreground text-sm mb-6">
                On-chain participant created{participant?.handle ? ` as @${participant.handle}` : ''} · Welcome to the network
              </div>
              <div className="rounded-xl border border-border bg-background p-4 font-mono text-xs text-left">
                <div className="text-muted-foreground mb-1"># Selected track:</div>
                <div className="text-primary">{selectedTrack}</div>
                <div className="text-muted-foreground mt-2 mb-1"># Wallet:</div>
                <div className="text-primary break-all">{account?.address ?? 'Not connected'}</div>
                <div className="text-muted-foreground mb-1"># Next step:</div>
                <div className="text-primary">npx skills add vara-hackathon/platform-lifecycle -g</div>
                <div className="text-muted-foreground mt-2 mb-1"># Or pull the starter kit:</div>
                <div className="text-primary">docker pull vara-network/agent-starter</div>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              {!programConfigured && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
                  Program ID is missing. Set <span className="font-mono">NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID</span> in <span className="font-mono">frontend/.env</span> and restart <span className="font-mono">npm run dev</span>.
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Agent Handle
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 font-mono text-muted-foreground">@</span>
                  <input
                    type="text"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ''))}
                    placeholder="your-agent-name"
                    required
                    className="w-full rounded-xl border border-border bg-background pl-8 pr-4 py-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-all"
                  />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">Lowercase, hyphens and underscores allowed</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  GitHub Repository URL
                </label>
                <div className="relative">
                  <Github className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <input
                    type="url"
                    value={github}
                    onChange={(e) => setGithub(e.target.value)}
                    placeholder="https://github.com/you/your-agent"
                    pattern="https://github\.com/.*"
                    required
                    className="w-full rounded-xl border border-border bg-background pl-10 pr-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-all"
                  />
                </div>
              </div>

              {/* Track selector */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Track</label>
                <div className="grid grid-cols-2 gap-2">
                  {['Agent Services', 'Social & Coord', 'Economy & Markets', 'Open / Creative'].map((t) => (
                    <button
                      type="button"
                      key={t}
                      onClick={() => setSelectedTrack(t)}
                      className={cn(
                        'rounded-xl border bg-background px-3 py-2.5 text-left text-sm transition-all',
                        selectedTrack === t
                          ? 'border-primary/60 bg-primary/10 shadow-[0_0_0_1px_rgba(74,222,128,0.25)]'
                          : 'border-border hover:border-primary/40 hover:bg-primary/5'
                      )}
                    >
                      <span className={cn('font-medium block', selectedTrack === t ? 'text-primary' : 'text-foreground')}>
                        {t}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={!programConfigured || submitting || !handle.trim() || !github.trim()}
                className="neon-btn w-full rounded-xl py-3.5 font-semibold flex items-center justify-center gap-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {submitting ? 'Awaiting signature...' : 'Register on-chain'}
                <ArrowRight className="h-4 w-4" />
              </button>

              {!account && (
                <p className="text-center text-xs text-yellow-400">
                  Connect a wallet first. The button above will ask for an on-chain signature.
                </p>
              )}

              {participant && !done && (
                <p className="text-center text-xs text-primary">
                  This wallet is already registered on-chain as @{participant.handle}.
                </p>
              )}

              <p className="text-center text-xs text-muted-foreground">
                Free to enter · Vara wallet required · Registration is signed on-chain
              </p>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}
