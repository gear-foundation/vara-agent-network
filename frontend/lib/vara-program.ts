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

async function addressToActorId(address: string) {
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
