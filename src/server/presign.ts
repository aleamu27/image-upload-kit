import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'

export interface CreatePresignedUploadOptions {
  client: S3Client
  bucketName: string
  publicUrl: string
  /** Folder/prefix, e.g. 'avatars' or 'property-photos'. No leading/trailing slash. */
  folder: string
  extension: string
  contentType: string
  expiresInSeconds?: number
}

export interface PresignedUpload {
  uploadUrl: string
  publicUrl: string
  key: string
}

export async function createPresignedUpload(options: CreatePresignedUploadOptions): Promise<PresignedUpload> {
  const key = `${options.folder}/${randomUUID()}.${options.extension}`

  const command = new PutObjectCommand({
    Bucket: options.bucketName,
    Key: key,
    ContentType: options.contentType,
  })

  const uploadUrl = await getSignedUrl(options.client, command, {
    expiresIn: options.expiresInSeconds ?? 300,
  })

  return { uploadUrl, publicUrl: `${options.publicUrl}/${key}`, key }
}

/**
 * Fetches just the first few bytes of an already-uploaded object — enough
 * to sniff its real format — used by the confirm-upload route to verify a
 * presigned-PUT upload after the fact, without downloading the whole file.
 */
export async function fetchObjectHeadBytes(
  client: S3Client,
  bucketName: string,
  key: string,
  byteCount = 16
): Promise<Uint8Array> {
  const command = new GetObjectCommand({ Bucket: bucketName, Key: key, Range: `bytes=0-${byteCount - 1}` })
  const response = await client.send(command)
  const body = await response.Body?.transformToByteArray()
  return body ?? new Uint8Array()
}

/**
 * Returns an object's real stored size. A presigned PUT URL (unlike a
 * presigned POST with a policy document) doesn't cap the size of what a
 * client actually uploads — the size the client declared when requesting
 * the presigned URL is never enforced by R2 itself. This is what lets the
 * confirm-upload route check the real size after the fact and reject
 * anything over the limit, instead of trusting the client's claim.
 */
export async function fetchObjectSize(client: S3Client, bucketName: string, key: string): Promise<number> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }))
  return head.ContentLength ?? 0
}

export async function deleteR2Object(client: S3Client, bucketName: string, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
}

export interface PromoteUploadOptions {
  client: S3Client
  bucketName: string
  publicUrl: string
  pendingKey: string
  /** Final prefix/folder to move the object into, e.g. 'uploads'. No leading/trailing slash. */
  folder: string
}

export interface PromotedUpload {
  key: string
  publicUrl: string
}

/**
 * Moves a verified object from its temporary "pending" key to its
 * permanent location — copy then delete, since S3-compatible storage has
 * no atomic rename. Called by confirm-upload-route.ts once an upload has
 * passed byte-signature and size verification.
 *
 * This is what makes cleaning up abandoned presigned uploads simple: only
 * objects still under the pending prefix can ever be orphaned (a client
 * that got a presigned URL and never finished), so an R2 lifecycle rule
 * (or the optional cleanup-pending-route.ts) only ever needs to target
 * that one prefix — confirmed images have already moved out of it.
 */
export async function promoteUpload(options: PromoteUploadOptions): Promise<PromotedUpload> {
  const filename = options.pendingKey.split('/').pop()
  const finalKey = `${options.folder}/${filename}`

  await options.client.send(
    new CopyObjectCommand({
      Bucket: options.bucketName,
      CopySource: `${options.bucketName}/${options.pendingKey}`,
      Key: finalKey,
    })
  )
  await options.client.send(new DeleteObjectCommand({ Bucket: options.bucketName, Key: options.pendingKey }))

  return { key: finalKey, publicUrl: `${options.publicUrl}/${finalKey}` }
}
