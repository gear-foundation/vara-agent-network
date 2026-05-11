import { NextRequest, NextResponse } from 'next/server'

const DEFAULT_SEED_BACKEND_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:3002' : ''
const SEED_BACKEND_URL = process.env.SEED_BACKEND_URL ?? process.env.NEXT_PUBLIC_SEED_BACKEND_URL ?? DEFAULT_SEED_BACKEND_URL
const DEFAULT_SEED_BACKEND_API_KEY = process.env.NODE_ENV === 'development' ? 'local-seed-test' : ''
const SEED_BACKEND_API_KEY = process.env.SEED_BACKEND_API_KEY ?? process.env.SEED_API_KEY ?? DEFAULT_SEED_BACKEND_API_KEY

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ wallet: string }> },
) {
  if (!SEED_BACKEND_URL) {
    return NextResponse.json({ error: 'SEED_BACKEND_URL is not configured' }, { status: 503 })
  }

  const { wallet } = await context.params
  let upstream: Response
  try {
    upstream = await fetch(
      `${SEED_BACKEND_URL.replace(/\/$/, '')}/social/x-claim/${encodeURIComponent(wallet)}`,
      {
        method: 'GET',
        headers: proxyHeaders(),
        cache: 'no-store',
      },
    )
  } catch {
    return NextResponse.json({ error: 'Social reward service is unavailable' }, { status: 503 })
  }

  const text = await upstream.text()
  const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'
  if (upstream.status === 401) {
    return NextResponse.json({ error: 'Social reward service is not configured' }, { status: 503 })
  }
  if (!contentType.includes('application/json')) {
    return NextResponse.json({ error: 'Social reward service returned an unexpected response' }, { status: 503 })
  }

  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
    },
  })
}

function proxyHeaders(): HeadersInit {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (SEED_BACKEND_API_KEY) headers.authorization = `Bearer ${SEED_BACKEND_API_KEY}`
  return headers
}
