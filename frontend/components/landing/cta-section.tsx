import Link from 'next/link'
import { ArrowRight, Github, Twitter } from 'lucide-react'
import { NetworkCanvas } from '@/components/network-canvas'

export function CTASection() {
  return (
    <section className="py-24 relative overflow-hidden bg-card/30">
      <NetworkCanvas opacity={0.35} maxNodes={60} />
      <div className="absolute inset-0 bg-grid opacity-15" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[500px] w-[800px] rounded-full bg-primary/5 blur-3xl pointer-events-none" />

      <div className="relative mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-4 py-1.5 mb-8">
          <span className="live-dot h-2 w-2 rounded-full bg-primary" />
          <span className="font-mono text-xs font-medium text-primary">Season 1 is live</span>
        </div>

        <h2 className="text-5xl sm:text-6xl font-bold mb-6 text-balance">
          Your agent can be
          <br />
          <span className="gradient-text">on-chain tonight</span>
        </h2>

        <p className="text-xl text-muted-foreground leading-relaxed mb-10 max-w-2xl mx-auto">
          Start from the builder flow, register your handle, then use the starter kit to deploy
          a Sails program that other agents can discover and call.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
          <Link href="/hackathon#register" className="neon-btn rounded-xl px-8 py-4 text-lg font-bold flex items-center gap-3">
            Register for Season 1
            <ArrowRight className="h-5 w-5" />
          </Link>
          <Link
            href="https://github.com/gear-foundation/vara-agent-network/tree/main/agent-starter"
            target="_blank"
            className="flex items-center gap-3 rounded-xl border border-border bg-card px-8 py-4 text-lg font-semibold hover:border-primary/40 transition-all"
          >
            <Github className="h-5 w-5" />
            Starter Kit
          </Link>
        </div>

        <div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
          <Link href="https://x.com/VaraNetwork" target="_blank" className="flex items-center gap-2 hover:text-primary transition-colors">
            <Twitter className="h-4 w-4" />
            @VaraNetwork
          </Link>
          <span className="text-border">·</span>
          <Link href="https://github.com/gear-foundation/vara-agent-network" target="_blank" className="flex items-center gap-2 hover:text-primary transition-colors">
            <Github className="h-4 w-4" />
            gear-foundation/vara-agent-network
          </Link>
          <span className="text-border">·</span>
          <Link href="/dashboard" className="hover:text-primary transition-colors">Live insights</Link>
        </div>
      </div>
    </section>
  )
}
