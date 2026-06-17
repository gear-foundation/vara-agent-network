import { ProjectReviewWorkbench } from '@/components/project-review-workbench'
import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { SiteFooter } from '@/components/site-footer'
import { getProjectReviewDetail } from '@/lib/indexer-client'

export default async function ProjectReviewDetailPage({
  params,
}: {
  params: Promise<{ projectReviewId: string }>
}) {
  const { projectReviewId } = await params
  const detail = await getProjectReviewDetail(projectReviewId)

  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>
      <main className="page">
        <ProjectReviewWorkbench projectReviewId={projectReviewId} initialDetail={detail} />
      </main>
      <SiteFooter />
    </div>
  )
}
