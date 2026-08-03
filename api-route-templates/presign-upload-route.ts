/**
 * TEMPLATE — copy to app/api/upload/presign/route.ts
 *
 * Returns a short-lived presigned URL the browser uploads directly to R2
 * with — the file's bytes never pass through this server, so there's no
 * serverless body-size ceiling to worry about. Trade-off: this route only
 * ever sees the client's *claimed* filename/type, never the actual bytes.
 * Pair this with confirm-upload-route.ts, which verifies the real content
 * after the client's PUT completes, to get the same guarantee
 * proxy-upload-route.ts gives inline.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createR2Client, loadR2ConfigFromEnv } from '../src/server/r2-client'
import { createPresignedUpload } from '../src/server/presign'
import { ALLOWED_IMAGE_TYPES } from '../src/core/image-types'
import { checkRateLimit } from '../src/server/rate-limit'
import { isRequestTooLarge, getClientIP } from '../src/server/http'

const MAX_SIZE_MB = 15
const RATE_LIMIT = { maxRequests: 20, windowMs: 10 * 60 * 1000 }

export async function POST(request: NextRequest) {
  // TODO: check the caller is authenticated/authorized to upload.

  const ip = getClientIP(request)
  const { allowed, retryAfter } = checkRateLimit(`image-presign:${ip}`, RATE_LIMIT)
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many uploads. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter || 600) } }
    )
  }

  if (isRequestTooLarge(request)) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
  }

  let body: { fileName?: string; fileType?: string; fileSize?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { fileType, fileSize } = body
  if (!fileType || !(fileType in ALLOWED_IMAGE_TYPES)) {
    return NextResponse.json({ error: 'Unsupported or missing file type' }, { status: 400 })
  }
  if (!fileSize || fileSize > MAX_SIZE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `File must be smaller than ${MAX_SIZE_MB}MB` }, { status: 400 })
  }

  const config = loadR2ConfigFromEnv()
  const client = createR2Client(config)

  const { uploadUrl, publicUrl, key } = await createPresignedUpload({
    client,
    bucketName: config.bucketName,
    publicUrl: config.publicUrl,
    folder: 'uploads',
    extension: ALLOWED_IMAGE_TYPES[fileType].extension,
    contentType: fileType,
  })

  return NextResponse.json({ uploadUrl, publicUrl, key })
}
