import { Trophy, Award, Star } from 'lucide-react'

const PLACE_PRIZES = [
  { place: '1st', amount: '$4,000', icon: Trophy, color: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/30' },
  { place: '2nd', amount: '$2,500', icon: Trophy, color: 'text-gray-300', bg: 'bg-gray-300/10', border: 'border-gray-300/20' },
  { place: '3rd', amount: '$1,500', icon: Trophy, color: 'text-amber-700', bg: 'bg-amber-700/10', border: 'border-amber-700/20' },
  { place: '4th–7th', amount: '$400 each', icon: Star, color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/20' },
  { place: '8th–10th', amount: '$133 each', icon: Star, color: 'text-accent', bg: 'bg-accent/10', border: 'border-accent/20' },
]

const BONUS_PRIZES = [
  {
    title: 'Best Integration Award',
    desc: 'Most meaningful cross-agent integrations. Reflected in the Top Integrators leaderboard.',
    icon: Award,
  },
  {
    title: 'Network Utility Award',
    desc: 'Most real on-chain interactions from unique wallets. Pure usage, no noise.',
    icon: Trophy,
  },
  {
    title: 'Best Demo / Social Proof',
    desc: 'Best PR-ready content for Vara A2A Network. Best 30-60s demo video + GIF.',
    icon: Star,
  },
]

export function PrizesSection() {
  return (
    <section className="py-20 bg-background" id="prizes">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <div className="inline-block font-mono text-xs text-yellow-400 border border-yellow-400/30 bg-yellow-400/5 rounded-full px-3 py-1 mb-4">
            PRIZE POOL
          </div>
          <h2 className="text-4xl sm:text-5xl font-bold">
            <span className="gradient-text">$40,000</span>
            <br />
            <span className="text-foreground">across 4 tracks</span>
          </h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            Each track awards $10,000 to the top 10 applications. Plus cross-track bonus prizes for the best integrators, network utility generators, and demo creators.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">
          {/* Per-track breakdown */}
          <div className="rounded-2xl border border-border bg-card/60 overflow-hidden">
            <div className="border-b border-border px-6 py-4 flex items-center justify-between">
              <span className="font-semibold text-foreground">Per-Track Prizes</span>
              <span className="font-mono text-sm text-primary font-bold">$10,000 / track</span>
            </div>
            <div className="divide-y divide-border/60">
              {PLACE_PRIZES.map((p) => {
                const Icon = p.icon
                return (
                  <div key={p.place} className={`flex items-center justify-between px-6 py-4 hover:bg-secondary/20 transition-colors`}>
                    <div className="flex items-center gap-3">
                      <div className={`h-9 w-9 rounded-lg border ${p.border} ${p.bg} flex items-center justify-center`}>
                        <Icon className={`h-4 w-4 ${p.color}`} />
                      </div>
                      <span className="font-medium text-foreground">{p.place} Place</span>
                    </div>
                    <span className={`font-mono font-bold text-lg ${p.color}`}>{p.amount}</span>
                  </div>
                )
              })}
            </div>
            <div className="border-t border-border bg-secondary/20 px-6 py-3 flex justify-between">
              <span className="text-xs text-muted-foreground">Top 10 per track · 4 tracks</span>
              <span className="font-mono text-xs font-bold text-foreground">Total: $40,000</span>
            </div>
          </div>

          {/* Bonus prizes */}
          <div className="space-y-4">
            <h3 className="font-semibold text-foreground mb-4">Cross-Track Bonus Awards</h3>
            {BONUS_PRIZES.map((b) => {
              const Icon = b.icon
              return (
                <div
                  key={b.title}
                  className="flex gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5 hover:border-primary/40 transition-all"
                >
                  <div className="h-10 w-10 flex-shrink-0 rounded-xl border border-primary/30 bg-primary/10 flex items-center justify-center">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <div className="font-semibold text-foreground mb-1">{b.title}</div>
                    <div className="text-sm text-muted-foreground leading-relaxed">{b.desc}</div>
                  </div>
                </div>
              )
            })}

            {/* Investor pitch bonus */}
            <div className="rounded-2xl border border-accent/20 bg-accent/5 p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-xs text-accent border border-accent/30 rounded-full px-2 py-0.5">+10% BONUS</span>
                <span className="font-semibold text-foreground">Investor-style Pitch</span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Submit an investor-style pitch (what it does, who it&apos;s for, hypothesis tested, why Vara, survival plan)
                for a +10% bonus on your manual review score.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
