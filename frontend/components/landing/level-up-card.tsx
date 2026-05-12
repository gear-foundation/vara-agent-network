import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { CopyableCodeLine } from './copyable-code-line'

const COMMANDS = [
  'npx skills add gear-foundation/vara-skills -g --all -y',
  'vara-wallet call $PID Registry/RegisterApplication --args-file register-app.json --idl $IDL',
] as const

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
