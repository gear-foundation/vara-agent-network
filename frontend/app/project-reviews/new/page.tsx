import { ProjectReviewSubmitForm } from '@/components/project-review-submit-form'
import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { SiteFooter } from '@/components/site-footer'

export default function NewProjectReviewPage() {
  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>
      <main className="page">
        <section className="section">
          <ProjectReviewSubmitForm />
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
