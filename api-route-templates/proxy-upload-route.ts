/**
 * TEMPLATE — copy to app/api/upload/image/route.ts
 *
 * The simpler of the two upload flows: the file passes through this route,
 * so its actual bytes are verified here before being stored. Keep uploads
 * well under your host's serverless function body-size limit — Vercel's
 * default is ~4.5MB for Node.js Serverless Functions, so a 10MB image
 * would be rejected by the platform before this code even runs. For
 * larger files, use presign-upload-route.ts instead, which uploads
 * directly to R2 and isn't bound by that ceiling.
 *
 * Note on the size checks below: `request.formData()` has to read the
 * entire multipart body into memory to parse it — there's no way to
 * stream-reject an oversized file partway through with the standard Web
 * Request API, so the isRequestTooLarge() pre-check (which can be skipped
 * entirely if the client omits Content-Length) is only ever a best-effort
 * early-out, not a hard ceiling on memory use. `file.size` is checked
 * again immediately after parsing — that value comes from the runtime's
 * already-buffered result, not a header, so it's accurate — specifically
 * to avoid allocating a second, unnecessary copy of an oversized file via
 * arrayBuffer() before rejecting it.
 *
 * Add your own authentication/authorization check where marked — this
 * template intentionally doesn't assume any particular auth system.
 */

import { NextRequest, NextResponse } from 'next/server'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'
import { createR2Client, loadR2ConfigFromEnv } from '../src/server/r2-client'
import { validateImageBuffer } from '../src/server/validate-upload'
import { checkRateLimit } from '../src/server/rate-limit'
import { isRequestTooLarge, getClientIP } from '../src/server/http'

const MAX_SIZE_MB = 4 // keep under Vercel's ~4.5MB serverless body limit; raise only if you know your host allows more
const RATE_LIMIT = { maxRequests: 20, windowMs: 10 * 60 * 1000 }

export async function POST(request: NextRequest) {
  // TODO: check the caller is authenticated/authorized to upload, e.g.:
  //   const user = await requireAuth(request)
  //   if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ip = getClientIP(request)
  const { allowed, retryAfter } = checkRateLimit(`image-upload:${ip}`, RATE_LIMIT)
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many uploads. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter || 600) } }
    )
  }

  if (isRequestTooLarge(request, MAX_SIZE_MB * 1024 * 1024 + 10_000)) {
    return NextResponse.json({ error: 'File too large' }, { status: 413 })
  }

  const formData = await request.formData()
  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (file.size > MAX_SIZE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `File exceeds ${MAX_SIZE_MB}MB limit` }, { status: 413 })
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const validation = validateImageBuffer(bytes, { maxSizeBytes: MAX_SIZE_MB * 1024 * 1024 })
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  const config = loadR2ConfigFromEnv()
  const client = createR2Client(config)
  const key = `uploads/${randomUUID()}.${validation.extension}`

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: bytes,
      ContentType: validation.mimeType,
    })
  )

  return NextResponse.json({ url: `${config.publicUrl}/${key}`, key })
}
