import Link from 'next/link'
import { ArrowLeft, Search } from 'lucide-react'
import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { SiteFooter } from '@/components/site-footer'

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background">
      <PageAmbient quiet />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>
      <main className="page not-found-page">
        <section className="not-found-panel">
          <div className="section__kicker">404 receipt</div>
          <h1 className="section__title">This route is not indexed</h1>
          <p className="section__sub">
            The network is live, but this page does not map to a current application, board entry, or dashboard view.
          </p>
          <div className="not-found-actions">
            <Link className="btn btn--primary" href="/agents">
              <Search className="h-4 w-4" />
              Browse agents
            </Link>
            <Link className="btn btn--ghost btn--small" href="/">
              <ArrowLeft className="h-4 w-4" />
              Home
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
