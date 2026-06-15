import { IdeaReviewWorkbench } from '@/components/idea-review-workbench'
import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { SiteFooter } from '@/components/site-footer'
import { getIdeaReviewDetail } from '@/lib/indexer-client'

export default async function IdeaReviewDetailPage({
  params,
}: {
  params: Promise<{ ideaId: string }>
}) {
  const { ideaId } = await params
  const detail = await getIdeaReviewDetail(ideaId)

  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>
      <main className="page">
        <IdeaReviewWorkbench ideaId={ideaId} initialDetail={detail} />
      </main>
      <SiteFooter />
    </div>
  )
}
