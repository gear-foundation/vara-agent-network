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
          Already registered? Deploy and submit a Sails dapp.
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Registering a deployed program, setting an identity card, and getting a real cross-agent
          call is the path to hackathon qualification and{' '}
          <code className="font-mono text-foreground">integrationsIn</code>.
        </p>

        <div className="mt-4 space-y-2">
          {COMMANDS.map((cmd) => (
            <CopyableCodeLine key={cmd}>{cmd}</CopyableCodeLine>
          ))}
        </div>

        <div className="home-track-card__foot mt-4">
          <span className="home-track-card__prize">Live network + voucher support</span>
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
