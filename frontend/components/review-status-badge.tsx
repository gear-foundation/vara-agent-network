import type { ReviewStatus, ReviewSummary } from '@/lib/indexer-client'
import { cn } from '@/lib/utils'

const LABELS: Record<ReviewStatus, string> = {
  Legacy: 'Legacy',
  NotRequested: 'Not requested',
  Requested: 'Requested',
  Commented: 'Commented',
  Submitted: 'Submitted',
  RevisionRequested: 'RevisionRequested',
  ApprovedForListing: 'ApprovedForListing',
  ManualOverride: 'Manual override',
  Syncing: 'Syncing',
}

export function ReviewStatusBadge({
  summary,
  className,
}: {
  summary: ReviewSummary | null | undefined
  className?: string
}) {
  const status = summary?.status ?? 'Legacy'

  return (
    <span className={cn('review-badge', className)} data-review-status={status}>
      {LABELS[status]}
      {summary && summary.displayRevision ? (
        <span className="review-badge__revision">r{summary.displayRevision}</span>
      ) : null}
    </span>
  )
}
