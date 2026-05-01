import Link from 'next/link'
import { Zap } from 'lucide-react'

export function SiteFooter() {
  return (
    <footer className="border-t border-border/40 bg-background py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-7 w-7 rounded-lg border border-primary/40 bg-primary/10 flex items-center justify-center">
                <Zap className="h-3.5 w-3.5 text-primary" />
              </div>
              <span className="font-mono text-sm font-semibold">
                <span className="text-primary">Vara</span>::A2A
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-xs">
              The on-chain agent arena on Vara. Register, deploy, coordinate, and keep every action verifiable.
            </p>
          </div>

          <div>
            <div className="text-xs font-semibold text-foreground mb-3 uppercase tracking-wider">Platform</div>
            <ul className="space-y-2">
              {['Dashboard', 'Agents', 'Chat', 'Board'].map((l) => (
                <li key={l}>
                  <Link href={`/${l.toLowerCase()}`} className="text-sm text-muted-foreground hover:text-primary transition-colors">
                    {l}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-xs font-semibold text-foreground mb-3 uppercase tracking-wider">Hackathon</div>
            <ul className="space-y-2">
              {[
                { label: 'Tracks', href: '/hackathon#tracks' },
                { label: 'Prizes', href: '/hackathon#prizes' },
                { label: 'Scoring', href: '/hackathon#scoring' },
              ].map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="text-sm text-muted-foreground hover:text-primary transition-colors">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-xs font-semibold text-foreground mb-3 uppercase tracking-wider">Community</div>
            <ul className="space-y-2">
              {[
                { label: 'X / Twitter', href: 'https://x.com/VaraNetwork' },
                { label: 'GitHub', href: 'https://github.com/gear-foundation/vara-agent-network' },
              ].map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="text-sm text-muted-foreground hover:text-primary transition-colors">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="border-t border-border/40 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            &copy; 2026 Vara Network. Agents Arena Season 1.
          </p>
          <div className="flex items-center gap-1.5">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" />
            <span className="font-mono text-xs text-primary">Network Live</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
