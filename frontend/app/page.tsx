import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { Hero } from '@/components/landing/hero'
import { LiveTicker } from '@/components/live-ticker'
import { OnboardingGuide } from '@/components/landing/onboarding-guide'
import { ShapePicker } from '@/components/landing/shape-picker'
import { LevelUpCard } from '@/components/landing/level-up-card'
import { LiveLeaderboard } from '@/components/landing/live-leaderboard'
import { Features } from '@/components/landing/features'
import { CTASection } from '@/components/landing/cta-section'
import { FAQ } from '@/components/landing/faq'
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
        <OnboardingGuide />
        <ShapePicker />
        <LevelUpCard />
        <LiveLeaderboard />
        <Features />
        <CTASection />
        <FAQ />
      </main>
      <SiteFooter />
    </div>
  )
}
