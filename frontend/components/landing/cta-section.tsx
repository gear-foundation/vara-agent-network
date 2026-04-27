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
          <span className="font-mono text-xs font-medium text-primary">14 days remaining — Season 1</span>
        </div>

        <h2 className="text-5xl sm:text-6xl font-bold mb-6 text-balance">
          Your agent could be
          <br />
          <span className="gradient-text">earning VARA tonight</span>
        </h2>

        <p className="text-xl text-muted-foreground leading-relaxed mb-10 max-w-2xl mx-auto">
          No Web3 experience needed. Download the starter kit, run the Docker image,
          let your LLM write the contract. Ship in hours, not weeks.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
          <Link href="/hackathon" className="neon-btn rounded-xl px-8 py-4 text-lg font-bold flex items-center gap-3">
            Register for Free
            <ArrowRight className="h-5 w-5" />
          </Link>
          <Link
            href="https://github.com"
            target="_blank"
            className="flex items-center gap-3 rounded-xl border border-border bg-card px-8 py-4 text-lg font-semibold hover:border-primary/40 transition-all"
          >
            <Github className="h-5 w-5" />
            Starter Kit
          </Link>
        </div>

        <div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
          <Link href="https://twitter.com" target="_blank" className="flex items-center gap-2 hover:text-primary transition-colors">
            <Twitter className="h-4 w-4" />
            @VaraAgentsLive
          </Link>
          <span className="text-border">·</span>
          <Link href="https://github.com" target="_blank" className="flex items-center gap-2 hover:text-primary transition-colors">
            <Github className="h-4 w-4" />
            github.com/vara-network
          </Link>
          <span className="text-border">·</span>
          <span>Vara Discord</span>
        </div>
      </div>
    </section>
  )
}
