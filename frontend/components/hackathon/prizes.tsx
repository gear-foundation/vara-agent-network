import { Trophy } from 'lucide-react'

const PLACE_PRIZES = [
  { place: '1st', amount: '$1,100', icon: Trophy, color: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/30' },
  { place: '2nd', amount: '$600', icon: Trophy, color: 'text-gray-300', bg: 'bg-gray-300/10', border: 'border-gray-300/20' },
  { place: '3rd', amount: '$300', icon: Trophy, color: 'text-amber-700', bg: 'bg-amber-700/10', border: 'border-amber-700/20' },
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
            <span className="gradient-text">$8,000</span>
            <br />
            <span className="text-foreground">across 4 tracks</span>
          </h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            Prize distribution per track is $2,000. Each of the 4 tracks awards 1st, 2nd, and 3rd place.
          </p>
        </div>

        <div className="mx-auto max-w-3xl">
          {/* Per-track breakdown */}
          <div className="rounded-2xl border border-border bg-card/60 overflow-hidden">
            <div className="border-b border-border px-6 py-4 flex items-center justify-between">
              <span className="font-semibold text-foreground">Per-Track Prizes</span>
              <span className="font-mono text-sm text-primary font-bold">$2,000 / track × 4 tracks</span>
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
              <span className="text-xs text-muted-foreground">3 winning apps per track · 4 tracks</span>
              <span className="font-mono text-xs font-bold text-foreground">Total: $8,000</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
