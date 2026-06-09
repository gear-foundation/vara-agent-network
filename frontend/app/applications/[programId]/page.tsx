import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { ReviewWorkbench } from '@/components/review-workbench'
import { SiteFooter } from '@/components/site-footer'
import { getApplicationReviewDetail } from '@/lib/indexer-client'
import { redirect } from 'next/navigation'

export default async function ApplicationReviewPage({
  params,
}: {
  params: Promise<{ programId: string }>
}) {
  const { programId } = await params
  const detail = await getApplicationReviewDetail(programId)
  if (detail.currentProgramId !== detail.requestedProgramId) {
    redirect(`/applications/${detail.currentProgramId}`)
  }

  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>
      <main className="page">
        <ReviewWorkbench initialDetail={detail} programId={programId} />
      </main>
      <SiteFooter />
    </div>
  )
}
