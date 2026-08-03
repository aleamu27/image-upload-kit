/**
 * TEMPLATE — copy to app/api/upload/confirm/route.ts
 *
 * Pairs with presign-upload-route.ts. After the client's direct PUT to R2
 * finishes, useImageUpload calls this with the returned `key` to verify
 * the object's real bytes match an allowed image signature, and that its
 * real size doesn't exceed the limit — if either check fails, the object
 * is deleted rather than left sitting in your bucket unverified and
 * publicly reachable.
 *
 * The size check matters because a presigned PUT URL doesn't actually cap
 * upload size: presign-upload-route.ts only checks the *claimed* fileSize
 * before issuing the URL, but nothing stops a client from then PUTting a
 * much larger file straight to R2. This route re-checks the real,
 * server-reported size after the fact.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createR2Client, loadR2ConfigFromEnv } from '../src/server/r2-client'
import { fetchObjectHeadBytes, fetchObjectSize, deleteR2Object } from '../src/server/presign'
import { sniffImageMimeType, ALLOWED_IMAGE_TYPES } from '../src/core/image-types'
import { checkRateLimit } from '../src/server/rate-limit'
import { isRequestTooLarge, getClientIP } from '../src/server/http'

// Keep in sync with MAX_SIZE_MB in presign-upload-route.ts — that one only
// gates what URL gets issued, this one gates what's actually kept.
const MAX_SIZE_MB = 15
const RATE_LIMIT = { maxRequests: 20, windowMs: 10 * 60 * 1000 }

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 250): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)))
      }
    }
  }
  throw lastError
}

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

  // Retried: a transient network blip between this server and R2 right
  // after the client's own PUT completed shouldn't cost the visitor their
  // just-uploaded, genuinely valid image.
  let head: Uint8Array
  let sizeBytes: number
  try {
    ;[head, sizeBytes] = await withRetry(() =>
      Promise.all([
        fetchObjectHeadBytes(client, config.bucketName, body.key!),
        fetchObjectSize(client, config.bucketName, body.key!),
      ])
    )
  } catch (error) {
    console.error('[confirm-upload] Could not read back uploaded object after retries:', error)
    return NextResponse.json({ error: 'Could not verify the upload. Please try again.' }, { status: 502 })
  }

  const sniffed = sniffImageMimeType(head)
  const tooLarge = sizeBytes > MAX_SIZE_MB * 1024 * 1024

  if (!sniffed || !(sniffed in ALLOWED_IMAGE_TYPES) || tooLarge) {
    await deleteR2Object(client, config.bucketName, body.key)
    const error = tooLarge ? `File exceeds the ${MAX_SIZE_MB}MB limit and was removed` : 'Uploaded file is not a valid image and was removed'
    return NextResponse.json({ error }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
