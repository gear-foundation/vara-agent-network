export type SocialXClaimStatus = 'PENDING' | 'SENT' | 'FAILED'

export type SocialXClaim = {
  status: SocialXClaimStatus
  wallet: string
  participantHandle: string
  tweetUrl: string
  tweetId: string
  tweetAuthor: string
  rewardVara: number
  txHash: string | null
  error: string | null
  createdAt: string
  sentAt: string | null
}
