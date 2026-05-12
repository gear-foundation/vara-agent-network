'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, ExternalLink, Loader2, Send } from 'lucide-react'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { toast } from '@/hooks/use-toast'
import { buildSocialXClaimMessage, type SocialXClaim } from '@/lib/social-x-claim'

type ClaimResponse = {
  claim: SocialXClaim | null
  rewardVara?: number
  participantMinAgeSec?: number
  error?: string
}

const SOCIAL_X_POST_TEXTS = [
  'My agent deploys programs, finds markets, and sells services to other agents - autonomously. Building on @VaraNetwork A2A.',
  'Shipped an agent that researches the network, writes programs, and starts messaging other agents on its own. @VaraNetwork A2A Hackathon.',
  'Agent live on @VaraNetwork. It finds niches, deploys programs, and trades with other agents - no human in the loop.',
]

function pickSocialXPostText() {
  return SOCIAL_X_POST_TEXTS[Math.floor(Math.random() * SOCIAL_X_POST_TEXTS.length)]
}

export function SocialClaim() {
  const {
    status: walletStatus,
    account,
    participant,
    participantLoading,
    connect,
    signMessage,
  } = useVaraWallet()
  const [claim, setClaim] = useState<SocialXClaim | null>(null)
  const [rewardVara, setRewardVara] = useState(100)
  const [tweetUrl, setTweetUrl] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [loadingClaim, setLoadingClaim] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [serviceUnavailable, setServiceUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [portalReady, setPortalReady] = useState(false)
  const [tweetUrlTouched, setTweetUrlTouched] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [tweetText] = useState(pickSocialXPostText)

  const tweetIntentUrl = useMemo(
    () => `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`,
    [tweetText],
  )
  const tweetUrlError = useMemo(() => validateTweetUrl(tweetUrl), [tweetUrl])

  const refreshClaim = useCallback(async () => {
    if (!account) {
      setClaim(null)
      return
    }

    setLoadingClaim(true)
    setError(null)
    setServiceUnavailable(false)
    try {
      const res = await fetch(`/api/social/x-claim/${encodeURIComponent(account.address)}`, { cache: 'no-store' })
      const data = await readClaimResponse(res)
      if (res.status === 503) {
        setServiceUnavailable(true)
        return
      }
      if (!res.ok) {
        if (res.status === 404 || res.status >= 500) {
          setServiceUnavailable(true)
          return
        }
        throw new Error(data.error ?? 'Failed to load social reward status')
      }
      setClaim(data.claim)
      if (data.rewardVara) setRewardVara(data.rewardVara)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingClaim(false)
    }
  }, [account])

  useEffect(() => {
    void refreshClaim()
  }, [refreshClaim])

  useEffect(() => {
    if (!account || !claim || claim.status === 'SENT') return
    const id = window.setInterval(() => {
      void refreshClaim()
    }, 10_000)
    return () => window.clearInterval(id)
  }, [account, claim, refreshClaim])

  useEffect(() => {
    setPortalReady(true)
  }, [])

  useEffect(() => {
    if (!modalOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [modalOpen])

  async function submitClaim() {
    setSubmitAttempted(true)
    if (!account) {
      await connect()
      return
    }
    if (!participant) return

    setSubmitting(true)
    setChecking(false)
    setError(null)
    try {
      const cleanTweetUrl = tweetUrl.trim()
      const localError = validateTweetUrl(cleanTweetUrl)
      if (localError) throw new Error(localError)
      const message = buildSocialXClaimMessage(account.address, cleanTweetUrl, rewardVara)
      const signature = await signMessage(message)
      setChecking(true)
      const res = await fetch('/api/social/x-claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          wallet: account.address,
          tweetUrl: cleanTweetUrl,
          signature,
        }),
      })
      const data = await readClaimResponse(res)
      if (res.status === 503) {
        setServiceUnavailable(true)
        throw new Error('Social reward service is being prepared. Please try again later.')
      }
      if (!res.ok || !data.claim) throw new Error(data.error ?? 'Could not submit tweet claim')
      setClaim(data.claim)
      setModalOpen(false)
      toast({
        title: 'Tweet is being checked',
        description: 'Your 100 VARA reward is queued. We will send it after the review window.',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
      setChecking(false)
    }
  }

  const disabled = Boolean(claim) || submitting || checking || participantLoading || loadingClaim || serviceUnavailable
  const needsWallet = walletStatus !== 'connected' || !account
  const needsParticipant = !needsWallet && !participant && !participantLoading

  return (
    <article className="social-claim">
      <div className="social-claim__copy">
        <div className="section__kicker">Social reward</div>
        <h3>100 VARA for your X post</h3>
        <p>
          Registered participants can submit one fresh X post about joining the hackathon.
          The reward is one-time per wallet, tweet, and X username.
        </p>
      </div>

      <div className="social-claim__status" data-state={claim?.status ?? 'ready'}>
        {loadingClaim || participantLoading ? (
          <>
            <Loader2 size={18} className="social-claim__spin" />
            <span>Checking reward status</span>
          </>
        ) : claim?.status === 'SENT' ? (
          <>
            <CheckCircle2 size={18} />
            <span>100 VARA sent</span>
          </>
        ) : claim?.status === 'PENDING' ? (
          <>
            <Loader2 size={18} className="social-claim__spin" />
            <span>We are checking your tweet</span>
          </>
        ) : claim?.status === 'FAILED' ? (
          <>
            <Loader2 size={18} className="social-claim__spin" />
            <span>Reward queued, no action needed</span>
          </>
        ) : serviceUnavailable ? (
          <span>Reward service warming up</span>
        ) : needsParticipant ? (
          <span>Register as a participant first</span>
        ) : (
          <span>Awaiting tweet URL</span>
        )}
      </div>

      {claim ? (
        <a className="btn btn--ghost social-claim__tweet" href={claim.tweetUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={16} />
          View submitted post
        </a>
      ) : needsWallet ? (
        <button className="btn btn--primary" type="button" onClick={() => void connect()}>
          Connect wallet
        </button>
      ) : (
        <button
          className="btn btn--primary"
          type="button"
          disabled={disabled || needsParticipant}
          onClick={() => setModalOpen(true)}
        >
          <Send size={16} />
          Submit tweet
        </button>
      )}

      {error && !serviceUnavailable ? <p className="social-claim__error">{error}</p> : null}
      {serviceUnavailable ? (
        <p className="social-claim__muted">The reward queue is being prepared. Submission will open once the backend is connected.</p>
      ) : null}

      {modalOpen && portalReady ? createPortal(
        <div className="social-claim-modal" role="dialog" aria-modal="true" aria-labelledby="social-claim-title">
          <button className="social-claim-modal__backdrop" type="button" aria-label="Close" onClick={() => setModalOpen(false)} />
          <div className="social-claim-modal__panel">
            <button className="social-claim-modal__close" type="button" onClick={() => setModalOpen(false)} aria-label="Close">
              <span aria-hidden="true">×</span>
            </button>
            <div className="section__kicker">X reward</div>
            <h3 id="social-claim-title">Post, paste the link, sign</h3>
            <div className="social-claim-modal__steps">
              <span>1. Create the post</span>
              <span>2. Paste its URL</span>
            </div>
            <div className="social-claim-modal__tweet">{tweetText}</div>
            <a className="btn btn--primary social-claim-modal__intent" href={tweetIntentUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              Open X composer with this post
            </a>
            <label className="social-claim-modal__field">
              <span>Tweet URL</span>
              <input
                value={tweetUrl}
                onChange={(event) => {
                  setTweetUrl(event.target.value)
                  setTweetUrlTouched(true)
                }}
                onBlur={() => setTweetUrlTouched(true)}
                placeholder="https://x.com/username/status/1234567890"
                disabled={submitting}
                autoFocus
              />
            </label>
            {(tweetUrlTouched || submitAttempted) && tweetUrlError ? (
              <p className="social-claim-modal__field-error">{tweetUrlError}</p>
            ) : null}
            <button className="btn btn--primary social-claim-modal__submit" type="button" onClick={() => void submitClaim()} disabled={submitting || Boolean(tweetUrlError)}>
              {submitting ? <Loader2 size={16} className="social-claim__spin" /> : <Send size={16} />}
              {checking ? 'Checking your tweet' : submitting ? 'Signing claim' : 'I posted it'}
            </button>
            {checking ? (
              <p className="social-claim-modal__checking">We are validating the tweet link and queueing your reward.</p>
            ) : null}
            {error ? <p className="social-claim__error">{error}</p> : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </article>
  )
}

function validateTweetUrl(value: string): string | null {
  const clean = value.trim()
  if (!clean) return 'Paste the URL of your X post to continue.'

  let url: URL
  try {
    url = new URL(clean)
  } catch {
    return 'Tweet URL must be a valid X/Twitter URL.'
  }

  const host = url.hostname.toLowerCase()
  const validHost = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host)
  if (!validHost) return 'Tweet URL must be from x.com or twitter.com.'

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 3 || !['status', 'statuses'].includes(parts[1]) || !/^\d{10,25}$/.test(parts[2])) {
    return 'Tweet URL must look like https://x.com/username/status/1234567890.'
  }

  return null
}

async function readClaimResponse(res: Response): Promise<ClaimResponse> {
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return await res.json() as ClaimResponse
  }

  return {
    claim: null,
    error: 'Social reward service returned an unexpected response. Check SEED_BACKEND_URL.',
  }
}
