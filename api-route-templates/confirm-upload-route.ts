/**
 * TEMPLATE — copy to app/api/upload/confirm/route.ts
 *
 * Pairs with presign-upload-route.ts. After the client's direct PUT to R2
 * finishes, useImageUpload calls this with the returned `key` to verify
 * the object's real bytes match an allowed image signature — if they
 * don't, the object is deleted rather than left sitting in your bucket
 * unverified and publicly reachable.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createR2Client, loadR2ConfigFromEnv } from '../src/server/r2-client'
import { fetchObjectHeadBytes, deleteR2Object } from '../src/server/presign'
import { sniffImageMimeType, ALLOWED_IMAGE_TYPES } from '../src/core/image-types'
import { checkRateLimit } from '../src/server/rate-limit'
import { isRequestTooLarge, getClientIP } from '../src/server/http'

const RATE_LIMIT = { maxRequests: 20, windowMs: 10 * 60 * 1000 }

export async function POST(request: NextRequest) {
  // TODO: check the caller is authenticated (ideally: owns this upload).

  const ip = getClientIP(request)
  const { allowed, retryAfter } = checkRateLimit(`image-confirm:${ip}`, RATE_LIMIT)
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(retryAfter || 600) } }
    )
  }

  if (isRequestTooLarge(request)) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
  }

  let body: { key?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // Restrict to the folder prefix presign-upload-route.ts issues keys
  // under, so this route can't be used to probe/delete arbitrary objects.
  if (!body.key || !body.key.startsWith('uploads/')) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 400 })
  }

  const config = loadR2ConfigFromEnv()
  const client = createR2Client(config)

  const head = await fetchObjectHeadBytes(client, config.bucketName, body.key)
  const sniffed = sniffImageMimeType(head)

  if (!sniffed || !(sniffed in ALLOWED_IMAGE_TYPES)) {
    await deleteR2Object(client, config.bucketName, body.key)
    return NextResponse.json({ error: 'Uploaded file is not a valid image and was removed' }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
