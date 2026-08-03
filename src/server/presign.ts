import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
