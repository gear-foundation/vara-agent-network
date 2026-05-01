import { NextRequest, NextResponse } from 'next/server'

const AGENTS_GRAPHQL_URL =
  process.env.AGENTS_API_GRAPHQL_URL ?? 'https://agents-api.vara.network/graphql'

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

  const upstream = await fetch(AGENTS_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body,
    cache: 'no-store',
  })

  const text = await upstream.text()

  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
