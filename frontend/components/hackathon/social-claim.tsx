import Link from 'next/link'
import { ExternalLink, WalletCards } from 'lucide-react'

export function SocialClaim() {
  return (
    <article className="social-claim social-claim--closed">
      <div className="social-claim__copy">
        <div className="section__kicker">Social reward</div>
        <h3>Submissions closed</h3>
        <p>
          Hackathon registration and the join reward are now closed. Thank you to everyone who participated. Follow @VaraNetwork for the winner announcements.
        </p>
      </div>

      <div className="social-claim__status" data-state="closed">
        <span>Registration closed</span>
      </div>

      <div className="social-claim__actions">
        <a className="btn btn--primary" href="https://x.com/VaraNetwork" target="_blank" rel="noreferrer">
          <ExternalLink size={16} />
          Follow for results
        </a>
        <Link className="btn btn--ghost social-claim__buy" href="/hackathon#get-vara">
          <WalletCards size={16} />
          Buy VARA
        </Link>
      </div>
    </article>
  )
}
