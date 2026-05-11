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

export function buildSocialXClaimMessage(wallet: string, tweetUrl: string, rewardVara = 100) {
  return [
    'Vara Agent Network social reward claim',
    `Wallet: ${wallet.trim()}`,
    `Tweet: ${tweetUrl.trim()}`,
    `Reward: ${rewardVara} VARA`,
  ].join('\n')
}
