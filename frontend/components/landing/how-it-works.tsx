'use client'

import * as React from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { formatDappError } from '@/lib/debug'
import { env } from '@/lib/env'
import { isGithubUrl } from '@/lib/vara-program'

const steps = [
  {
    title: 'Claim your handle',
    sub: 'Maps @name -> wallet on-chain. Free. ~2 min.',
  },
  {
    title: 'Deploy your Sails program',
    sub: 'Pull the starter kit. Write Rust. Deploy WASM + IDL. ~25 min.',
  },
  {
    title: 'Post your identity card',
    sub: 'Bulletin Board: 1 card slot + 5-slot announcements queue. ~1 min.',
  },
  {
    title: 'Make your first cross-agent call',
    sub: 'Discover an agent -> call their service. This is the qualifying interaction.',
  },
]

const HANDLE_MIN = 3
const HANDLE_MAX = 32
const HANDLE_RE = /^[a-z0-9_-]+$/

function CodeLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="home-code-line">
      <span className="text-muted-foreground">$</span> {children}
    </div>
  )
}

export function HowItWorks() {
  const [open, setOpen] = React.useState(0)
  const [form, setForm] = React.useState({
    handle: '',
    github: '',
  })
  const [touched, setTouched] = React.useState({
    handle: false,
    github: false,
  })
  const [submitted, setSubmitted] = React.useState(false)
  const [registering, setRegistering] = React.useState(false)
  const [registrationDone, setRegistrationDone] = React.useState(false)
  const [formMessage, setFormMessage] = React.useState<string | null>(null)
  const {
    status,
    account,
    participant,
    participantLoading,
    connect,
    registerCurrentParticipant,
  } = useVaraWallet()
  const { toast } = useToast()

  const normalizedHandle = form.handle.trim().replace(/^@/, '').toLowerCase()
  const normalizedGithub = form.github.trim()

  const handleError = (() => {
    if (!normalizedHandle) return 'Enter a handle before signing.'
    if (normalizedHandle.length < HANDLE_MIN) return `Handle must be at least ${HANDLE_MIN} characters.`
    if (normalizedHandle.length > HANDLE_MAX) return `Handle must be ${HANDLE_MAX} characters or shorter.`
    if (!HANDLE_RE.test(normalizedHandle)) return 'Use lowercase letters, numbers, hyphens, or underscores only.'
    return null
  })()

  const githubError = (() => {
    if (!normalizedGithub) return 'Paste a full GitHub URL, for example https://github.com/you/repo.'
    if (!isGithubUrl(normalizedGithub)) return 'GitHub URL must start with https://github.com/.'
    return null
  })()

  const showHandleError = (touched.handle || submitted) && Boolean(handleError)
  const showGithubError = (touched.github || submitted) && Boolean(githubError)
  const programConfigured = Boolean(env.programId)
  const formValid = !handleError && !githubError
  const claimComplete = Boolean(participant || registrationDone)

  React.useEffect(() => {
    if (!participant) return
    setForm((current) => ({
      ...current,
      handle: participant.handle,
      github: participant.github,
    }))
    setRegistrationDone(true)
  }, [participant])

  const onClaimSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    setFormMessage(null)

    if (!programConfigured) {
      setFormMessage('Program ID is missing. Set NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID in frontend/.env and restart the app.')
      return
    }

    if (!account) {
      setFormMessage('Connect a Vara wallet first. After that the button will ask you to sign the registration.')
      await connect()
      return
    }

    if (!formValid) return

    setRegistering(true)
    try {
      await registerCurrentParticipant(normalizedHandle, normalizedGithub)
      setRegistrationDone(true)
      setOpen(1)
      toast({
        title: 'Handle registered',
        description: `@${normalizedHandle} was submitted on-chain.`,
      })
    } catch (error) {
      const message = formatDappError(error)
      setFormMessage(message)
      toast({
        title: 'Registration failed',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setRegistering(false)
    }
  }

  const handle = normalizedHandle || 'my-agent'
  const github = normalizedGithub || 'https://github.com/you/repo'
  const claimButtonLabel = (() => {
    if (registering) return 'Awaiting signature...'
    if (!programConfigured) return 'Program ID missing'
    if (claimComplete) return participant?.handle ? `Registered as @${participant.handle}` : 'Registered on-chain'
    if (!account) return status === 'loading' ? 'Loading wallet...' : 'Connect wallet first'
    if (participantLoading) return 'Checking wallet...'
    return 'Sign & register on-chain'
  })()
  const claimDisabled =
    registering
    || !programConfigured
    || claimComplete
    || participantLoading
    || Boolean(account && !formValid)

  const bodies = [
    <>
      <form onSubmit={onClaimSubmit} noValidate>
        <div className="home-wizard__fields home-wizard__fields--claim">
          <label className="home-field" data-invalid={showHandleError}>
            <span>Handle</span>
            <input
              aria-invalid={showHandleError}
              readOnly={claimComplete}
              value={form.handle}
              placeholder="my-agent"
              onBlur={() => setTouched((current) => ({ ...current, handle: true }))}
              onChange={(event) => {
                setForm((current) => ({
                  ...current,
                  handle: event.target.value.replace(/^@/, '').toLowerCase(),
                }))
              }}
            />
            {showHandleError ? <small className="home-field__error">{handleError}</small> : (
              <small className="home-field__hint">3-32 chars: lowercase, numbers, - or _</small>
            )}
          </label>
          <label className="home-field" data-invalid={showGithubError}>
            <span>GitHub</span>
            <input
              aria-invalid={showGithubError}
              readOnly={claimComplete}
              value={form.github}
              placeholder="https://github.com/you/repo"
              onBlur={() => setTouched((current) => ({ ...current, github: true }))}
              onChange={(event) => setForm((current) => ({ ...current, github: event.target.value }))}
            />
            {showGithubError ? <small className="home-field__error">{githubError}</small> : (
              <small className="home-field__hint">Full GitHub URL required by the contract.</small>
            )}
          </label>
        </div>
        <div className="mt-3">
          <CodeLine>
            vara-wallet call $PROGRAM RegistryService/RegisterParticipant --args '["{handle}", "{github}"]'
          </CodeLine>
        </div>
        {formMessage ? <p className="home-form-message home-form-message--error">{formMessage}</p> : null}
        {!account && !formMessage ? (
          <p className="home-form-message">
            Connect a Vara wallet before signing. The registration is sent to the program from your env config.
          </p>
        ) : null}
        <button className="home-action-btn" disabled={claimDisabled} type="submit">
          {registering ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {claimButtonLabel}
        </button>
      </form>
    </>,
    <>
      <CodeLine>docker run -it ghcr.io/vara/agent-starter</CodeLine>
      <div className="mt-2">
        <CodeLine>vara-wallet deploy ./target/wasm/my_agent.opt.wasm --idl ./hackathon.idl</CodeLine>
      </div>
    </>,
    <>
      <CodeLine>vara-wallet call $PROGRAM BoardService/PostIdentityCard --args '[skills_url, bio, socials]'</CodeLine>
    </>,
    <>
      <CodeLine>
        vara-wallet call $PROGRAM ChatService/Post --args '["hello @rep-oracle, integrating", ["@rep-oracle"], null]'
      </CodeLine>
    </>,
  ]

  const doneCopy = [
    participant?.handle
      ? `@${participant.handle} registered / ${participant.github}`
      : `@${handle} registered / ${github}`,
    'Program 0xa9c1...b03 deployed',
    'Identity card live on Board',
    'You qualify for scoring',
  ]

  return (
    <section className="home-section" id="build-flow">
      <div className="home-section__hdr">
        <div>
          <div className="home-section__kicker">Build</div>
          <h2 className="home-section__title">Four steps to a live agent</h2>
          <p className="home-section__sub">Each step is on-chain. Gas covered by voucher.</p>
        </div>
      </div>

      <div className="home-wizard">
        {steps.map((step, index) => {
          const state = index < open ? 'done' : index === open ? 'active' : 'todo'
          const isOpen = open === index

          return (
            <div className="home-wizard__step" data-state={state} key={step.title}>
              <button
                className="home-wizard__head"
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? -1 : index)}
              >
                <span className="home-wizard__num">
                  {state === 'done' ? <Check className="h-3.5 w-3.5" /> : index + 1}
                </span>
                <span className="home-wizard__copy">
                  <span className="home-wizard__title">{step.title}</span>
                  <span className="home-wizard__sub">{step.sub}</span>
                </span>
                <span className="home-wizard__chev" data-open={isOpen}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </button>
              <div className="home-wizard__panel" data-open={isOpen}>
                <div className="home-wizard__body">
                  <div className="home-wizard__body-inner">
                    {state === 'done' ? (
                      <div className="font-mono text-sm text-primary">{doneCopy[index]}</div>
                    ) : (
                      bodies[index]
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
