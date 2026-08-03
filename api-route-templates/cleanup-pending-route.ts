/**
 * TEMPLATE — copy to app/api/upload/cleanup/route.ts (optional)
 *
 * Fallback for when you can't or don't want to configure an R2 lifecycle
 * rule (see the root README's "Cleaning up orphaned uploads" — that's the
 * recommended approach, this is the app-level alternative). Lists objects
 * under 'pending/' older than MAX_AGE_HOURS and deletes them — those are
 * exactly the ones a client got a presigned URL for and then never
 * finished (or never called confirm-upload-route.ts for).
 *
 * Meant to be triggered periodically, not by end users. Written for
 * Vercel Cron out of the box: Vercel sends a GET request and, if you set
 * the CRON_SECRET env var, an `Authorization: Bearer <CRON_SECRET>`
 * header automatically — this route checks for exactly that. Add to
 * vercel.json:
 *
 *   { "crons": [{ "path": "/api/upload/cleanup", "schedule": "0 3 * * *" }] }
 *
 * Using a different scheduler? Swap the auth check below for whatever fits
 * (a shared header/query secret, etc.) — just make sure it's protected,
 * since this route deletes objects.
 */

import { NextRequest, NextResponse } from 'next/server'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { createR2Client, loadR2ConfigFromEnv } from '../src/server/r2-client'

const MAX_AGE_HOURS = 24
const PENDING_PREFIX = 'pending/'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const config = loadR2ConfigFromEnv()
  const client = createR2Client(config)
  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000)

  let deletedCount = 0
  let continuationToken: string | undefined

  do {
    const listResult = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: PENDING_PREFIX,
        ContinuationToken: continuationToken,
      })
    )

    const staleKeys = (listResult.Contents ?? [])
      .filter((obj) => obj.Key && obj.LastModified && obj.LastModified < cutoff)
      .map((obj) => ({ Key: obj.Key! }))

    if (staleKeys.length > 0) {
      // DeleteObjects takes up to 1000 keys per call — ListObjectsV2 pages
      // at the same size by default, so this never needs to chunk further.
      await client.send(
        new DeleteObjectsCommand({
          Bucket: config.bucketName,
          Delete: { Objects: staleKeys },
        })
      )
      deletedCount += staleKeys.length
    }

    continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined
  } while (continuationToken)

  return NextResponse.json({ deletedCount })
}
