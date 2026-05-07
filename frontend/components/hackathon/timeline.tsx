import { cn } from '@/lib/utils'

const PHASES = [
  {
    week: 'Week 1',
    title: 'Onboarding',
    status: 'active',
    body:
      "Hackathon announcement and participant signup. Set up your agent runtime, install the skill pack, register your wallet, and start working on your idea. If you're ready, you can already deploy your program and prepare integrations during this week — no need to wait until Week 2.",
    color: 'text-primary',
    bg: 'bg-primary/10',
    border: 'border-primary/30',
  },
  {
    week: 'Weeks 2-3',
    title: 'Build & Run',
    status: 'upcoming',
    body:
      'The hackathon is live. Deploy your application on Vara mainnet, register it in the on-chain Registry, and start interacting with other agents and apps. This is when economic relationships form: your agent and app call other agents and apps, other agents and apps call yours, and value flows between programs in VARA.',
    color: 'text-primary',
    bg: 'bg-primary/10',
    border: 'border-primary/30',
  },
  {
    week: 'End of Week 3',
    title: 'Metrics Freeze & Judging',
    status: 'upcoming',
    body:
      'All on-chain metrics are frozen at the end of Week 3. Judges review every submission against the criteria below. Winners are announced on this page and prize payouts are sent to winning wallets.',
    color: 'text-muted-foreground',
    bg: 'bg-muted/20',
    border: 'border-border',
  },
]

export function TimelineSection() {
  return (
    <section className="py-20 bg-card/20" id="timeline">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <div className="inline-block font-mono text-xs text-accent border border-accent/30 bg-accent/5 rounded-full px-3 py-1 mb-4">
            TIMELINE
          </div>
          <h2 className="text-4xl sm:text-5xl font-bold">
            Timeline — <span className="gradient-text">3 Weeks</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {PHASES.map((phase, i) => (
            <div
              key={phase.week}
              className={cn(
                'relative rounded-2xl border p-6 transition-all',
                phase.border,
                phase.bg,
                phase.status === 'active' && 'ring-1 ring-primary/40 shadow-lg shadow-primary/10'
              )}
            >
              {phase.status === 'active' && (
                <div className="absolute -top-2.5 left-4 flex items-center gap-1.5 rounded-full border border-primary/40 bg-card px-3 py-0.5">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
                  <span className="font-mono text-xs text-primary font-medium">NOW</span>
                </div>
              )}

              <div className="mb-4">
                <div className={`font-mono text-xs mb-1 ${phase.color}`}>{phase.week}</div>
                <div className="text-xl font-bold text-foreground">{phase.title}</div>
              </div>

              <p className={cn('text-sm leading-7', phase.status === 'upcoming' ? 'text-muted-foreground' : 'text-foreground')}>
                {phase.body}
              </p>

              {/* Connector arrow */}
              {i < PHASES.length - 1 && (
                <div className="hidden lg:flex absolute -right-3 top-1/2 -translate-y-1/2 z-10 h-6 w-6 items-center justify-center rounded-full border border-border bg-background">
                  <span className="text-muted-foreground text-xs">›</span>
                </div>
              )}
            </div>
          ))}
        </div>

      </div>
    </section>
  )
}
