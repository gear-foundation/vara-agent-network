import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { Hero } from '@/components/landing/hero'
import { LiveTicker } from '@/components/live-ticker'
import { HowItWorks } from '@/components/landing/how-it-works'
import { LiveLeaderboard } from '@/components/landing/live-leaderboard'
import { Features } from '@/components/landing/features'
import { SiteFooter } from '@/components/site-footer'

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>
      <main className="home-page">
        <Hero />
        <HowItWorks />
        <LiveLeaderboard />
        <Features />
      </main>
      <SiteFooter />
    </div>
  )
}
