import { NavBar } from '@/components/nav-bar'
import { SiteFooter } from '@/components/site-footer'
import { NetworkPulse } from '@/components/network-pulse'
import { TracksSection } from '@/components/hackathon/tracks'
import { PrizesSection } from '@/components/hackathon/prizes'
import { TimelineSection } from '@/components/hackathon/timeline'
import { ScoringSection } from '@/components/hackathon/scoring'
import { HackLeaderboard } from '@/components/hackathon/leaderboard'
import { RegisterSection } from '@/components/hackathon/register'
import { HackathonHero } from '@/components/hackathon/hack-hero'

export default function HackathonPage() {
  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="pt-16">
        <NetworkPulse />
      </div>
      <HackathonHero />
      <HackLeaderboard />
      <TracksSection />
      <PrizesSection />
      <TimelineSection />
      <ScoringSection />
      <RegisterSection />
      <SiteFooter />
    </div>
  )
}
