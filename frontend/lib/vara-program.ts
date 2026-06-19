'use client'

import { env } from '@/lib/env'
import { logError, logInfo } from '@/lib/debug'

export type WalletAccount = {
  address: string
  name?: string
  source: string
}

export type ParticipantRecord = {
  handle: string
  github: string
  joined_at: string | number
  season_id: number
}

export type HandleRef =
  | { Participant: string }
  | { Application: string }
  | { participant: string }
  | { application: string }

export type PostChatParams = {
  account: WalletAccount
  body: string
  replyTo?: string | number | null
}

export type ReviewCoverage = 'Missing' | 'Partial' | 'Met' | 'NotApplicable'
export type ProjectGuidanceOutcome = 'Proceed' | 'NeedsChanges' | 'NotRecommended'

export type ReviewCriteriaInput = {
  technical_readiness: { coverage: ReviewCoverage; note?: string | null }
  network_value: { coverage: ReviewCoverage; note?: string | null }
  evidence_quality: { coverage: ReviewCoverage; note?: string | null }
  safety_maintenance: { coverage: ReviewCoverage; note?: string | null }
}

export type ProgramConfig = {
  paused: boolean
  allow_participant_registration: boolean
  allow_application_registration: boolean
  allow_chat: boolean
  allow_board_updates: boolean
  allow_review: boolean
  require_project_review_approval: boolean
  max_chat_body: number
  max_review_body_bytes: number
  max_mentions_per_post: number
  mention_inbox_cap: number
  max_announcements_per_app: number
  chat_rate_limit_ms: string | number
  board_rate_limit_ms: string | number
  review_rate_limit_ms: string | number
}

const APP_NAME = 'Vara A2A Network'
const IDL_PATH = '/idl/agents_network_client.idl'
const GITHUB_URL_PREFIX = 'https://github.com/'

let idlPromise: Promise<string> | null = null
let apiPromise: Promise<any> | null = null
let sailsPromise: Promise<any> | null = null

function requireProgramId() {
  if (!env.programId) {
    throw new Error('Missing NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID. Add it to frontend/.env and restart npm run dev.')
  }

  return env.programId as `0x${string}`
}

export function isGithubUrl(value: string) {
  return value.trim().startsWith(GITHUB_URL_PREFIX)
}

async function loadIdl() {
  if (!idlPromise) {
    idlPromise = fetch(IDL_PATH, { cache: 'force-cache' }).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to load IDL from ${IDL_PATH}`)
      return res.text()
    })
  }

  return idlPromise
}

export async function getGearApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const { GearApi } = await import('@gear-js/api')
      logInfo('rpc', 'connecting', { endpoint: env.varaRpcUrl })
      const api = await GearApi.create({ providerAddress: env.varaRpcUrl })
      logInfo('rpc', 'connected')
      return api
    })()
  }

  return apiPromise
}

export async function getLatestBlockNumber() {
  try {
    const api = await getGearApi()
    const finalizedHead = await api.rpc.chain.getFinalizedHead()
    const header = await api.rpc.chain.getHeader(finalizedHead)
    return header.number.toNumber()
  } catch (error) {
    logError('rpc', 'failed to fetch finalized block', error)
    throw error
  }
}

export async function getProgramConfig(address?: string) {
  const sails = await getSailsClient()
  const query = sails.services.Admin.queries.GetConfig()
  const result = address ? await query.withAddress(address).call() : await query.call()
  return result as ProgramConfig
}

export async function getSailsClient() {
  if (!sailsPromise) {
    sailsPromise = (async () => {
      const [{ Sails }, { SailsIdlParser }, api, idl] = await Promise.all([
        import('sails-js'),
        import('sails-js-parser'),
        getGearApi(),
        loadIdl(),
      ])

      const parser = await SailsIdlParser.new()
      const sails = new Sails(parser)

      sails.parseIdl(idl)
      sails.setApi(api)
      sails.setProgramId(requireProgramId())
      logInfo('sails', 'client ready', { programId: env.programId })

      return sails
    })()
  }

  return sailsPromise
}

async function getSigner(account: WalletAccount) {
  const { web3FromSource } = await import('@polkadot/extension-dapp')
  const injector = await web3FromSource(account.source)
  return injector.signer
}

export async function addressToActorId(address: string) {
  const [{ decodeAddress }, { u8aToHex }] = await Promise.all([
    import('@polkadot/util-crypto'),
    import('@polkadot/util'),
  ])

  return u8aToHex(decodeAddress(address))
}

export async function getParticipant(address: string) {
  try {
    const actorId = await addressToActorId(address)
    logInfo('registry.query', 'GetParticipant', { address, actorId })
    const sails = await getSailsClient()
    const result = await sails.services.Registry.queries.GetParticipant(actorId)
      .withAddress(address)
      .call()

    logInfo('registry.query', 'GetParticipant result', result)
    return result as ParticipantRecord | null
  } catch (error) {
    logError('registry.query', 'GetParticipant failed', error, { address })
    throw error
  }
}

export async function resolveHandle(handle: string) {
  const normalized = handle.trim().replace(/^@/, '').toLowerCase()
  if (!normalized) return null

  try {
    logInfo('registry.query', 'ResolveHandle', { handle: normalized })
    const sails = await getSailsClient()
    const result = await sails.services.Registry.queries.ResolveHandle(normalized).call()
    logInfo('registry.query', 'ResolveHandle result', result)
    return result as HandleRef | null
  } catch (error) {
    logError('registry.query', 'ResolveHandle failed', error, { handle: normalized })
    throw error
  }
}

function normalizeHandleRef(ref: HandleRef): HandleRef {
  if ('participant' in ref) return { Participant: ref.participant }
  if ('application' in ref) return { Application: ref.application }
  return ref
}

export async function registerParticipant(
  account: WalletAccount,
  handle: string,
  github: string,
) {
  const normalizedHandle = handle.trim().replace(/^@/, '').toLowerCase()
  const normalizedGithub = github.trim()

  if (!isGithubUrl(normalizedGithub)) {
    throw new Error(`GitHub URL must start with ${GITHUB_URL_PREFIX}`)
  }

  try {
    logInfo('registry.tx', 'RegisterParticipant preparing', {
      account: account.address,
      handle: normalizedHandle,
      github: normalizedGithub,
    })
    const sails = await getSailsClient()
    const signer = await getSigner(account)
    const tx = sails.services.Registry.functions.RegisterParticipant(
      normalizedHandle,
      normalizedGithub,
    )

    tx.withAccount(account.address, { signer })
    logInfo('registry.tx', 'RegisterParticipant calculating gas')
    await tx.calculateGas()
    logInfo('registry.tx', 'RegisterParticipant signing')
    const result = await tx.signAndSend()
    logInfo('registry.tx', 'RegisterParticipant waiting for response')
    const response = await result.response()
    logInfo('registry.tx', 'RegisterParticipant confirmed', response)
    return result
  } catch (error) {
    logError('registry.tx', 'RegisterParticipant failed', error, {
      account: account.address,
      handle: normalizedHandle,
    })
    throw error
  }
}

export async function postChatMessage({ account, body, replyTo }: PostChatParams) {
  try {
    logInfo('chat.tx', 'Post preparing', {
      account: account.address,
      bodyLength: body.length,
      replyTo,
    })

    const mentionTokens = Array.from(
      new Set(
        (body.match(/@\w[\w-]*/g) ?? [])
          .map((token) => token.replace(/^@/, '').toLowerCase()),
      ),
    )

    const mentionRefs = (
      await Promise.all(mentionTokens.map((handle) => resolveHandle(handle)))
    ).map((resolved, index) => {
      if (!resolved) {
        throw new Error(`Unknown mention handle: @${mentionTokens[index]}`)
      }

      return normalizeHandleRef(resolved)
    })

    logInfo('chat.tx', 'Post mentions resolved', { mentionTokens, mentionRefs })
    const author: HandleRef = { Participant: await addressToActorId(account.address) }
    const sails = await getSailsClient()
    const signer = await getSigner(account)
    const tx = sails.services.Chat.functions.Post(
      body,
      author,
      mentionRefs,
      replyTo == null ? null : BigInt(replyTo),
    )

    tx.withAccount(account.address, { signer })
    logInfo('chat.tx', 'Post calculating gas')
    await tx.calculateGas()
    logInfo('chat.tx', 'Post signing')
    const result = await tx.signAndSend()
    logInfo('chat.tx', 'Post waiting for response')
    const response = await result.response()
    logInfo('chat.tx', 'Post confirmed', response)

    return {
      ...result,
      messageId: response,
    }
  } catch (error) {
    logError('chat.tx', 'Post failed', error, {
      account: account.address,
      body,
      replyTo,
    })
    throw error
  }
}

async function sendTx(account: WalletAccount, label: string, tx: any) {
  const signer = await getSigner(account)
  tx.withAccount(account.address, { signer })
  logInfo(label, 'calculating gas')
  await tx.calculateGas()
  logInfo(label, 'signing')
  const result = await tx.signAndSend()
  logInfo(label, 'waiting for response')
  const response = await result.response()
  logInfo(label, 'confirmed', response)
  return result
}

export async function isReviewer(address: string) {
  const actorId = await addressToActorId(address)
  const sails = await getSailsClient()
  return Boolean(await sails.services.Review.queries.IsReviewer(actorId).withAddress(address).call())
}

export async function listReviewers(address?: string) {
  const sails = await getSailsClient()
  const query = sails.services.Review.queries.ListReviewers()
  const result = address ? await query.withAddress(address).call() : await query.call()
  return (Array.isArray(result) ? result : []) as string[]
}

export async function isCoach(address: string) {
  const actorId = await addressToActorId(address)
  const sails = await getSailsClient()
  return Boolean(await sails.services.Review.queries.IsCoach(actorId).withAddress(address).call())
}

export async function listCoaches(address?: string) {
  const sails = await getSailsClient()
  const query = sails.services.Review.queries.ListCoaches()
  const result = address ? await query.withAddress(address).call() : await query.call()
  return (Array.isArray(result) ? result : []) as string[]
}

export async function addReviewer(account: WalletAccount, reviewer: string) {
  const actorId = reviewer.startsWith('0x') ? reviewer : await addressToActorId(reviewer)
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.AddReviewer(actorId)
  return sendTx(account, 'review.tx.AddReviewer', tx)
}

export async function removeReviewer(account: WalletAccount, reviewer: string) {
  const actorId = reviewer.startsWith('0x') ? reviewer : await addressToActorId(reviewer)
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.RemoveReviewer(actorId)
  return sendTx(account, 'review.tx.RemoveReviewer', tx)
}

export async function addCoach(account: WalletAccount, coach: string) {
  const actorId = coach.startsWith('0x') ? coach : await addressToActorId(coach)
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.AddCoach(actorId)
  return sendTx(account, 'review.tx.AddCoach', tx)
}

export async function removeCoach(account: WalletAccount, coach: string) {
  const actorId = coach.startsWith('0x') ? coach : await addressToActorId(coach)
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.RemoveCoach(actorId)
  return sendTx(account, 'review.tx.RemoveCoach', tx)
}

export async function submitApplication(account: WalletAccount, programId: string) {
  const sails = await getSailsClient()
  const tx = sails.services.Registry.functions.SubmitApplication(programId)
  return sendTx(account, 'registry.tx.SubmitApplication', tx)
}

export async function assertProgramIsDeployed(programId: string) {
  const normalized = programId.trim().toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('Program id must be a 0x-prefixed 32-byte hex ActorId.')
  }

  const api = await getGearApi()
  const storage = await api.query.gearProgram.programStorage(normalized)
  const human = storage.toHuman()
  const text = JSON.stringify(human)
  if (!text || text === 'null' || !text.includes('Active') || !text.includes('Initialized')) {
    throw new Error('New program id is not an active initialized Gear program.')
  }

  return normalized
}

export async function replaceApplicationProgram(
  account: WalletAccount,
  oldProgramId: string,
  newProgramId: string,
  reason: string,
) {
  const normalizedNewProgramId = await assertProgramIsDeployed(newProgramId)
  const sails = await getSailsClient()
  const tx = sails.services.Registry.functions.ReplaceApplicationProgram(
    oldProgramId,
    normalizedNewProgramId,
    reason,
  )
  return sendTx(account, 'registry.tx.ReplaceApplicationProgram', tx)
}

export async function requestReview(account: WalletAccount, programId: string, reason: string) {
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.RequestReview(programId, reason)
  return sendTx(account, 'review.tx.RequestReview', tx)
}

export async function postReviewerComment(
  account: WalletAccount,
  programId: string,
  revision: number,
  body: string,
) {
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.PostReviewerComment(programId, revision, body)
  return sendTx(account, 'review.tx.PostReviewerComment', tx)
}

export async function ownerReply(
  account: WalletAccount,
  programId: string,
  revision: number,
  body: string,
) {
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.OwnerReply(programId, revision, body)
  return sendTx(account, 'review.tx.OwnerReply', tx)
}

export async function decideReview(
  account: WalletAccount,
  programId: string,
  revision: number,
  verdict: 'ApprovedForListing' | 'RevisionRequested',
  reason: string,
  criteria: ReviewCriteriaInput,
) {
  const sails = await getSailsClient()
  const fn = verdict === 'ApprovedForListing'
    ? sails.services.Review.functions.ApproveForListing
    : sails.services.Review.functions.RequestRevision
  const tx = fn(programId, revision, reason, criteria)
  return sendTx(account, `review.tx.${verdict}`, tx)
}

export async function decidePublish(
  account: WalletAccount,
  programId: string,
  revision: number,
  outcome: 'Published' | 'ChangesRequested',
  reason: string,
  criteria: ReviewCriteriaInput,
) {
  const sails = await getSailsClient()
  const fn = outcome === 'Published'
    ? sails.services.Review.functions.PublishApplication
    : sails.services.Review.functions.RequestPublishChanges
  const tx = fn(programId, revision, reason, criteria)
  return sendTx(account, `review.tx.${outcome}`, tx)
}

export async function submitProjectReview(
  account: WalletAccount,
  githubUrl: string,
  idea: string,
) {
  const normalizedGithub = githubUrl.trim()
  if (!isGithubUrl(normalizedGithub)) {
    throw new Error(`GitHub URL must start with ${GITHUB_URL_PREFIX}`)
  }
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.SubmitProjectReview({
    github_url: normalizedGithub,
    idea: idea.trim(),
  })
  return sendTx(account, 'review.tx.SubmitProjectReview', tx)
}

export async function approveProjectReviewSubmission(
  account: WalletAccount,
  applicant: string,
  requestMessageId: string | number,
) {
  const actorId = applicant.startsWith('0x') ? applicant : await addressToActorId(applicant)
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.ApproveProjectReviewSubmission(
    actorId,
    BigInt(requestMessageId),
  )
  return sendTx(account, 'review.tx.ApproveProjectReviewSubmission', tx)
}

export async function submitApprovedProjectReview(
  account: WalletAccount,
  githubUrl: string,
  idea: string,
  approvalId: string | number,
) {
  const normalizedGithub = githubUrl.trim()
  if (!isGithubUrl(normalizedGithub)) {
    throw new Error(`GitHub URL must start with ${GITHUB_URL_PREFIX}`)
  }
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.SubmitApprovedProjectReview(
    {
      github_url: normalizedGithub,
      idea: idea.trim(),
    },
    BigInt(approvalId),
  )
  return sendTx(account, 'review.tx.SubmitApprovedProjectReview', tx)
}

export async function postProjectReviewerComment(
  account: WalletAccount,
  projectReviewId: string | number,
  body: string,
) {
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.PostProjectReviewerComment(BigInt(projectReviewId), body)
  return sendTx(account, 'review.tx.PostProjectReviewerComment', tx)
}

export async function ownerProjectReply(
  account: WalletAccount,
  projectReviewId: string | number,
  body: string,
) {
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.OwnerProjectReply(BigInt(projectReviewId), body)
  return sendTx(account, 'review.tx.OwnerProjectReply', tx)
}

export async function recordProjectGuidance(
  account: WalletAccount,
  projectReviewId: string | number,
  outcome: ProjectGuidanceOutcome,
  body: string,
) {
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.RecordProjectGuidance(BigInt(projectReviewId), outcome, body)
  return sendTx(account, 'review.tx.RecordProjectGuidance', tx)
}

export async function linkProjectReviewToApplication(
  account: WalletAccount,
  projectReviewId: string | number,
  programId: string,
) {
  const sails = await getSailsClient()
  const tx = sails.services.Review.functions.LinkProjectReviewToApplication(BigInt(projectReviewId), programId.trim())
  return sendTx(account, 'review.tx.LinkProjectReviewToApplication', tx)
}
