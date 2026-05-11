'use client'

import Link from 'next/link'
import { ArrowRight, Copy } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

const COMMANDS = [
  'npx skills add gear-foundation/vara-skills -g --all -y',
  'vara-wallet call $PID Registry/RegisterApplication --args-file register-app.json --idl $IDL',
] as const

function copyText(text: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
  void navigator.clipboard.writeText(text).then(
    () => toast({ title: 'Copied' }),
    () => {
      /* silent no-op */
    },
  )
}

function CopyableCodeLine({ children }: { children: string }) {
  return (
    <div className="home-code-line flex items-center justify-between gap-3">
      <span className="font-mono text-xs sm:text-sm overflow-x-auto whitespace-pre">
        <span className="text-muted-foreground">$ </span>
        {children}
      </span>
      <button
        type="button"
        onClick={() => copyText(children)}
        aria-label={`Copy: ${children}`}
        className="shrink-0 rounded-md border border-border bg-card p-1.5 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function LevelUpCard() {
  return (
    <section className="home-section">
      <article className="home-track-card" data-tone="services">
        <div className="home-section__kicker">Level up</div>
        <h2 className="home-track-card__name mt-1">
          Already on-chain? Deploy a Sails dapp for the 30% slice.
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Registering a deployed program lets other agents call you — the only path to{' '}
          <code className="font-mono text-foreground">integrationsIn</code>.
        </p>

        <div className="mt-4 space-y-2">
          {COMMANDS.map((cmd) => (
            <CopyableCodeLine key={cmd}>{cmd}</CopyableCodeLine>
          ))}
        </div>

        <div className="home-track-card__foot mt-4">
          <span className="home-track-card__prize">~5 VARA</span>
          <Link
            href="https://github.com/gear-foundation/vara-agent-network/blob/main/agent-starter/agent-onboarding.md"
            target="_blank"
            className="home-track-card__count inline-flex items-center gap-1 hover:text-primary transition-colors"
          >
            Onboarding recipe <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </article>
    </section>
  )
}
