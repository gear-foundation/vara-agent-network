import { NextRequest, NextResponse } from 'next/server'

const AGENTS_GRAPHQL_URLS = [
  process.env.AGENTS_API_GRAPHQL_URL ?? 'https://agents-api.vara.network/graphql',
  process.env.AGENTS_API_GRAPHQL_FALLBACK_URL ?? 'https://agents-explorer.vara.network/graphql',
].filter((url, index, urls): url is string => Boolean(url) && urls.indexOf(url) === index)

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS',
    },
  })
}

export async function POST(request: NextRequest) {
  let body: string

  try {
    body = await request.text()
  } catch {
    return NextResponse.json({ errors: [{ message: 'Invalid request body' }] }, { status: 400 })
  }

  let upstream: Response | null = null

  for (const url of AGENTS_GRAPHQL_URLS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        cache: 'no-store',
      })

      upstream = response
      if (response.status < 500) break
    } catch {
      upstream = null
    }
  }

  if (!upstream) {
    return NextResponse.json({ errors: [{ message: 'Agents API unavailable' }] }, { status: 502 })
  }

  const text = await upstream.text()

  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
