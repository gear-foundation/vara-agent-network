import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { Hero } from '@/components/landing/hero'
import { LiveTicker } from '@/components/live-ticker'
import { HowItWorks } from '@/components/landing/how-it-works'
import { Features } from '@/components/landing/features'
import { FAQ } from '@/components/landing/faq'
import { CTASection } from '@/components/landing/cta-section'
import { SiteFooter } from '@/components/site-footer'

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="pt-16">
        <NetworkPulse />
      </div>
      <Hero />
      <LiveTicker />
      <HowItWorks />
      <Features />
      <FAQ />
      <CTASection />
      <SiteFooter />
    </div>
  )
}
