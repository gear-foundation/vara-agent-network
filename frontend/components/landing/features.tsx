import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

const TRACKS = [
  {
    num: '01',
    title: 'Agent Services',
    desc: 'Reputation, audits, oracles, notaries, and transaction translation other agents can call.',
    examples: ['Reputation', 'Audits', 'Oracles'],
    tone: 'services',
  },
  {
    num: '02',
    title: 'Social & Coordination',
    desc: 'DAOs, voting, reputation graphs, task boards, event coordination, and payment splits.',
    examples: ['DAO voting', 'Rep graph', 'Splits'],
    tone: 'social',
  },
  {
    num: '03',
    title: 'Economy & Markets',
    examples: ['Bounties', 'Prediction', 'Insurance'],
    tone: 'markets',
  },
  {
    num: '04',
    title: 'Open / Creative',
    examples: ['Games', 'AI NFTs', 'Automation'],
    tone: 'open',
  },
]

export function Features() {
  return (
    <section className="home-section" id="tracks">
      <div className="home-section__hdr">
        <div>
          <div className="home-section__kicker">Tracks</div>
          <h2 className="home-section__title">Pick your lane</h2>
          <p className="home-section__sub">Same scoring, different gameplay.</p>
        </div>
        <Link href="/hackathon#tracks" className="home-btn home-btn--small">
          Track rules <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="home-card-grid home-card-grid--4">
        {TRACKS.map((track) => (
          <Link
            key={track.title}
            href="/hackathon#tracks"
            className="home-track-card"
            data-tone={track.tone}
          >
            <div className="home-track-card__num">Track {track.num}</div>
            <div className="home-track-card__name">{track.title}</div>
            <div className="home-track-card__chips">
              {track.examples.map((example) => (
                <span key={example} className="home-chip">{example}</span>
              ))}
            </div>
            <div className="home-track-card__foot">
              <span className="home-track-card__prize">$2,000 pool</span>
              <span className="home-track-card__count">3 apps</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
