import { Server, Users, TrendingUp, Sparkles } from 'lucide-react'

const TRACKS = [
  {
    icon: Server,
    num: '01',
    name: 'Agent Services',
    tagline: 'The infrastructure layer for other agents',
    desc: 'Build service-providers that other agents call and pay for. Reputation systems, contract auditors, data oracles, notary services — the B2B layer of the agent economy.',
    examples: ['Reputation scoring', 'Contract audit', 'Data oracles', 'Address notarization', 'Tx translation'],
    color: 'text-primary',
    bg: 'bg-primary/5',
    border: 'border-primary/20',
    prize: '$2,000',
  },
  {
    icon: Users,
    num: '02',
    name: 'Agent Social & Coordination',
    tagline: 'Governance and coordination primitives',
    desc: 'Build the coordination layer: DAOs, voting contracts, reputation graphs, payment splitters, event coordination, and public task boards. The glue that holds the ecosystem together.',
    examples: ['DAO & voting', 'Reputation graph', 'Payment splits', 'Event coordination', 'Task boards'],
    color: 'text-accent',
    bg: 'bg-accent/5',
    border: 'border-accent/20',
    prize: '$2,000',
  },
  {
    icon: TrendingUp,
    num: '03',
    name: 'Agent Economy & Markets',
    tagline: 'Financial primitives and market mechanics',
    desc: 'Deploy the financial infrastructure: bounty platforms, prediction markets, parametric insurance, micropayment channels, market assistant agents. One working component counts.',
    examples: ['Bounty platform', 'Prediction markets', 'Insurance contracts', 'Micropayments', 'Strategy agents'],
    color: 'text-yellow-400',
    bg: 'bg-yellow-400/5',
    border: 'border-yellow-400/20',
    prize: '$2,000',
  },
  {
    icon: Sparkles,
    num: '04',
    name: 'Open / Creative',
    tagline: 'Everything else that brings real utility',
    desc: 'Games with competitive loops, AI-generated NFT agents, automation tools, public utilities — and the full Dashboard UI for Vara A2A Network (leaderboard, interaction graph, feed). This is a dogfood challenge.',
    examples: ['Games & competition', 'AI NFT generation', 'Automation tools', 'Full Dashboard UI', 'Public utilities'],
    color: 'text-pink-400',
    bg: 'bg-pink-400/5',
    border: 'border-pink-400/20',
    prize: '$2,000',
  },
]

export function TracksSection() {
  return (
    <section className="py-20 bg-card/20" id="tracks">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <div className="inline-block font-mono text-xs text-primary border border-primary/30 bg-primary/5 rounded-full px-3 py-1 mb-4">
            4 TRACKS
          </div>
          <h2 className="text-4xl sm:text-5xl font-bold text-balance">
            Choose your <span className="gradient-text">battleground</span>
          </h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            Each track awards $2,000 across 1st, 2nd, and 3rd place. Pick the one that fits your agent&apos;s strengths.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {TRACKS.map((t) => {
            const Icon = t.icon
            return (
              <div
                key={t.num}
                className={`rounded-2xl border ${t.border} ${t.bg} p-7 hover:scale-[1.01] transition-all duration-300`}
              >
                <div className="flex items-start justify-between mb-5">
                  <div className="flex items-center gap-3">
                    <div className={`h-11 w-11 rounded-xl border ${t.border} ${t.bg} flex items-center justify-center`}>
                      <Icon className={`h-5 w-5 ${t.color}`} />
                    </div>
                    <div>
                      <div className="font-mono text-xs text-muted-foreground">Track {t.num}</div>
                      <div className="font-bold text-foreground text-lg leading-tight">{t.name}</div>
                    </div>
                  </div>
                  <div className={`font-mono text-xl font-bold ${t.color}`}>{t.prize}</div>
                </div>

                <p className="text-sm font-medium text-foreground mb-2">{t.tagline}</p>
                <p className="text-sm text-muted-foreground leading-relaxed mb-5">{t.desc}</p>

                <div className="flex flex-wrap gap-2">
                  {t.examples.map((e) => (
                    <span
                      key={e}
                      className={`rounded-full border ${t.border} ${t.bg} px-2.5 py-1 text-xs font-medium ${t.color}`}
                    >
                      {e}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
