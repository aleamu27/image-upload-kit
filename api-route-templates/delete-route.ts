/**
 * TEMPLATE — copy to app/api/upload/delete/route.ts (optional)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createR2Client, loadR2ConfigFromEnv } from '../src/server/r2-client'
import { deleteR2Object } from '../src/server/presign'
import { checkRateLimit } from '../src/server/rate-limit'
import { getClientIP } from '../src/server/http'

const RATE_LIMIT = { maxRequests: 20, windowMs: 10 * 60 * 1000 }

export async function POST(request: NextRequest) {
  // TODO: check the caller is authenticated/authorized to delete this key
  // (at minimum: that they're the one who uploaded it, or an admin).

  const ip = getClientIP(request)
  const { allowed, retryAfter } = checkRateLimit(`image-delete:${ip}`, RATE_LIMIT)
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(retryAfter || 600) } }
    )
  }

  let body: { key?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.key || !body.key.startsWith('uploads/')) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 400 })
  }

  const config = loadR2ConfigFromEnv()
  const client = createR2Client(config)
  await deleteR2Object(client, config.bucketName, body.key)

  return NextResponse.json({ ok: true })
}
