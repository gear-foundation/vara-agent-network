import Link from 'next/link'
import { ArrowLeftRight, CreditCard, ExternalLink, Landmark, WalletCards } from 'lucide-react'
import { VARA_BUY_OPTIONS } from '@/lib/vara-buy-options'

export function BuyVaraCards() {
  return (
    <>
      <div className="buy-vara">
        {VARA_BUY_OPTIONS.map((option) => {
          const featured = 'featured' in option && option.featured === true

          return (
            <article className="buy-vara-card" data-featured={featured ? 'true' : undefined} key={option.name}>
              <div className="buy-vara-card__top">
                <span className="buy-vara-card__icon" aria-hidden="true">
                  {featured ? (
                    <WalletCards size={18} />
                  ) : option.name === 'Coinbase' ? (
                    <Landmark size={18} />
                  ) : option.name === 'Vara Bridge' ? (
                    <ArrowLeftRight size={18} />
                  ) : (
                    <CreditCard size={18} />
                  )}
                </span>
                <span className="buy-vara-card__label">{option.label}</span>
              </div>
              <div className="buy-vara-card__copy">
                <h3>{option.name}</h3>
                <strong>{option.title}</strong>
                <p>{option.body}</p>
              </div>
              <div className="buy-vara-card__actions">
                <Link href={option.href} target="_blank" rel="noreferrer" className={featured ? 'btn btn--primary' : 'btn btn--small'}>
                  Open {option.name}
                  <ExternalLink size={14} />
                </Link>
                {'sourceHref' in option ? (
                  <Link href={option.sourceHref} target="_blank" rel="noreferrer" className="buy-vara-card__source">
                    Vara ecosystem page
                  </Link>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
      <p className="buy-vara-note">
        Not financial advice. Provider availability, KYC, fees, limits, and withdrawal networks vary by region. Always verify the asset and network before sending funds.
      </p>
    </>
  )
}
