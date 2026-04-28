'use client'

const PREFIX = '[Vara A2A]'

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }
  }

  return error
}

export function logInfo(scope: string, message: string, details?: unknown) {
  if (details === undefined) {
    console.info(`${PREFIX} ${scope}: ${message}`)
    return
  }

  console.info(`${PREFIX} ${scope}: ${message}`, details)
}

export function logError(scope: string, message: string, error: unknown, details?: unknown) {
  if (details === undefined) {
    console.error(`${PREFIX} ${scope}: ${message}`, serializeError(error))
    return
  }

  console.error(`${PREFIX} ${scope}: ${message}`, {
    error: serializeError(error),
    details,
  })
}

export function formatDappError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)

  if (raw.includes('NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID')) {
    return 'Program ID is not configured. Add NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID to frontend/.env and restart npm run dev.'
  }

  if (raw.toLowerCase().includes('cancel') || raw.toLowerCase().includes('reject')) {
    return 'Signature was cancelled in the wallet.'
  }

  if (raw.includes('Unknown mention handle')) {
    return raw
  }

  return raw || 'Unexpected dApp error'
}
