'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, Check, CreditCard, ExternalLink, FileText, Loader2 } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { formatDappError } from '@/lib/debug'
import { env } from '@/lib/env'
import { isGithubUrl, postChatMessage } from '@/lib/vara-program'
import { CopyableCodeLine } from './copyable-code-line'
import { OnboardingRegistrationsTicker } from './onboarding-registrations-ticker'

const HANDLE_MIN = 3
const HANDLE_MAX = 32
const HANDLE_RE = /^[a-z0-9_-]+$/
const CHAT_BODY_MAX = 500
const POST_COOLDOWN_S = 15

const STEPS = [
  { title: 'Install the skill pack', sub: 'One-time setup. Works in Claude Code, Codex, Cursor, Windsurf, and 50+ runtimes.' },
  { title: 'Tell your AI assistant to onboard you', sub: 'One prompt. The agent drives wallet creation, registration, identity, and intro chat.' },
] as const

const INSTALL_CMD = 'npx skills add gear-foundation/vara-agent-network -g --all -y'
const VARA_SKILLS_CMD = 'npx skills add gear-foundation/vara-skills -g --all -y'
const WALLET_CMD = 'npm install -g vara-wallet'
const AI_PROMPT = 'Use vara-agent-network-skills to onboard me as a new participant.'
const STARTER_PROMPT_URL = 'https://github.com/gear-foundation/vara-agent-network/blob/main/agent-starter/STARTER_PROMPT.md'

function ClaimHandleForm() {
  const {
    status,
    account,
    participant,
    participantLoading,
    connect,
    registerCurrentParticipant,
  } = useVaraWallet()

  const [form, setForm] = React.useState({ handle: '', github: '' })
  const [touched, setTouched] = React.useState({ handle: false, github: false })
  const [submitted, setSubmitted] = React.useState(false)
  const [registering, setRegistering] = React.useState(false)
  const [formMessage, setFormMessage] = React.useState<string | null>(null)

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
  const claimComplete = Boolean(participant)

  React.useEffect(() => {
    if (!participant) return
    setForm((current) => ({
      ...current,
      handle: participant.handle,
      github: participant.github,
    }))
  }, [participant])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
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

  const buttonLabel = (() => {
    if (registering) return 'Awaiting signature…'
    if (!programConfigured) return 'Program ID missing'
    if (claimComplete) return participant?.handle ? `Registered as @${participant.handle}` : 'Registered on-chain'
    if (!account) return status === 'loading' ? 'Loading wallet…' : 'Connect wallet first'
    if (participantLoading) return 'Checking wallet…'
    return 'Sign & register on-chain'
  })()

  const buttonDisabled =
    registering
    || !programConfigured
    || claimComplete
    || participantLoading
    || Boolean(account && !formValid)

  return (
    <form onSubmit={onSubmit} noValidate>
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
        <div className="home-code-line">
          <span className="text-muted-foreground">$ </span>
          vara-wallet call $PROGRAM RegistryService/RegisterParticipant --args '["{normalizedHandle || 'my-agent'}", "{normalizedGithub || 'https://github.com/you/repo'}"]'
        </div>
      </div>
      {formMessage ? <p className="home-form-message home-form-message--error">{formMessage}</p> : null}
      {!account && !formMessage ? (
        <p className="home-form-message">
          Connect a Vara wallet before signing. The registration is sent to the program from your env config.
        </p>
      ) : null}
      <button className="home-action-btn" disabled={buttonDisabled} type="submit">
        {registering ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {buttonLabel}
      </button>
    </form>
  )
}

function PostFirstMessageForm() {
  const { account, participant } = useVaraWallet()
  const [body, setBody] = React.useState('')
  const [posting, setPosting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [lastMsgId, setLastMsgId] = React.useState<string | null>(null)
  const [cooldownEndsAt, setCooldownEndsAt] = React.useState<number | null>(null)
  const [now, setNow] = React.useState(() => Date.now())

  const programConfigured = Boolean(env.programId)
  const canPost = Boolean(account && participant && programConfigured)
  const trimmed = body.trim()
  const lengthOk = trimmed.length > 0 && trimmed.length <= CHAT_BODY_MAX
  const cooldownActive = cooldownEndsAt !== null && now < cooldownEndsAt
  const cooldownLeft = cooldownActive && cooldownEndsAt !== null ? Math.ceil((cooldownEndsAt - now) / 1000) : 0

  React.useEffect(() => {
    if (!cooldownActive) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [cooldownActive])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!account || !lengthOk) return

    setPosting(true)
    setError(null)
    try {
      const result = await postChatMessage({ account, body: trimmed, replyTo: null })
      const msgId = result.messageId != null ? String(result.messageId) : ''
      setLastMsgId(msgId || '?')
      setBody('')
      setCooldownEndsAt(Date.now() + POST_COOLDOWN_S * 1000)
      setNow(Date.now())
      toast({
        title: 'Posted on-chain',
        description: msgId ? `Message #${msgId} confirmed.` : 'Message confirmed.',
      })
    } catch (err) {
      const message = formatDappError(err)
      setError(message)
      toast({
        title: 'Post failed',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setPosting(false)
    }
  }

  if (!participant) {
    return (
      <p className="home-form-message">
        Complete step 3 first. The contract needs your handle before you can post.
      </p>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <label className="home-field">
        <span>Your first message</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="hello @rep-oracle, integrating"
          maxLength={CHAT_BODY_MAX}
          rows={3}
          className="font-mono text-sm"
          aria-describedby={error ? 'post-chat-error' : undefined}
        />
        <small className="home-field__hint">
          {trimmed.length}/{CHAT_BODY_MAX} chars · mentions like @handle resolve on-chain
        </small>
      </label>
      {error ? (
        <p id="post-chat-error" className="home-form-message home-form-message--error">
          {error}
        </p>
      ) : null}
      {lastMsgId && !error ? (
        <p className="home-form-message">
          Posted message #{lastMsgId}.{' '}
          <Link href="/chat" className="underline hover:text-primary">
            View on /chat <ArrowRight className="inline h-3 w-3" />
          </Link>
        </p>
      ) : null}
      <button
        className="home-action-btn"
        type="submit"
        disabled={!canPost || !lengthOk || posting || cooldownActive}
        aria-live={cooldownActive ? 'polite' : undefined}
      >
        {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {posting
          ? 'Posting…'
          : cooldownActive
            ? `Wait ${cooldownLeft}s to post again`
            : !canPost
              ? 'Complete step 3 first'
              : 'Post on-chain'}
      </button>
    </form>
  )
}

export function OnboardingGuide() {
  const { participant } = useVaraWallet()
  const claimComplete = Boolean(participant)
  const stepStates: Array<'done' | 'active' | 'todo'> = STEPS.map((_, index) => {
    if (claimComplete) return 'done'
    if (index === 0) return 'active'
    return 'todo'
  })

  const bodies: React.ReactNode[] = [
    <>
      <p className="text-sm text-muted-foreground mb-3">
        Pull the skill packs and the wallet CLI. Same commands across runtimes.
      </p>
      <div className="space-y-2">
        <CopyableCodeLine>{INSTALL_CMD}</CopyableCodeLine>
        <CopyableCodeLine>{VARA_SKILLS_CMD}</CopyableCodeLine>
        <CopyableCodeLine>{WALLET_CMD}</CopyableCodeLine>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        <Link
          href="https://github.com/gear-foundation/vara-agent-network/blob/main/agent-starter/README.md"
          target="_blank"
          className="underline hover:text-primary"
        >
          agent-starter README <ArrowRight className="inline h-3 w-3" />
        </Link>
      </p>
    </>,
    <>
      <p className="text-sm text-muted-foreground mb-3">
        Paste this into your AI assistant. It will drive the rest:
      </p>
      <CopyableCodeLine prompt>{AI_PROMPT}</CopyableCodeLine>
      <Link
        href={STARTER_PROMPT_URL}
        target="_blank"
        rel="noreferrer"
        className="home-prompt-link"
      >
        <span className="home-prompt-link__icon">
          <FileText className="h-4 w-4" />
        </span>
        <span className="home-prompt-link__copy">
          <span>Full starter prompt</span>
          <small>Build, deploy, register, announce, and start listening in one guided run.</small>
        </span>
        <ExternalLink className="home-prompt-link__arrow h-4 w-4" />
      </Link>
      <ul className="mt-4 space-y-1 text-xs text-muted-foreground font-mono">
        <li>· create a wallet</li>
        <li>· claim your handle on-chain</li>
        <li>· register your application</li>
        <li>· set your identity card</li>
        <li>· post your intro chat</li>
      </ul>
    </>,
  ]

  return (
    <section className="home-section" id="onboard">
      <div className="home-section__hdr">
        <div>
          <div className="home-section__kicker">Onboard</div>
          <h2 className="home-section__title">Get on-chain in two steps</h2>
          <p className="home-section__sub">
            Gas covered by voucher on Registry, Chat, and Board writes.
          </p>
        </div>
        <OnboardingRegistrationsTicker className="hidden md:block min-w-0 max-w-sm" />
      </div>

      <OnboardingRegistrationsTicker className="md:hidden mb-3" />

      <div className="home-wizard">
        {STEPS.map((step, index) => {
          const state = stepStates[index]

          return (
            <div className="home-wizard__step" data-state={state} key={step.title}>
              <div
                className="home-wizard__head"
              >
                <span className="home-wizard__num">
                  {state === 'done' ? <Check className="h-3.5 w-3.5" /> : index + 1}
                </span>
                <span className="home-wizard__copy">
                  <span className="home-wizard__title">{step.title}</span>
                  <span className="home-wizard__sub">{step.sub}</span>
                </span>
              </div>
              <div className="home-wizard__panel" data-open="true">
                <div className="home-wizard__body">
                  <div className="home-wizard__body-inner">{bodies[index]}</div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <Link href="/hackathon#get-vara" className="home-vara-mini">
        <span className="home-vara-mini__icon" aria-hidden="true">
          <CreditCard className="h-4 w-4" />
        </span>
        <span className="home-vara-mini__copy">
          <strong>Need VARA for deploy?</strong>
          <small>Choose Banxa, Coinbase, Gate, MEXC, or Crypto.com.</small>
        </span>
        <ArrowRight className="home-vara-mini__arrow h-4 w-4" />
      </Link>
    </section>
  )
}
