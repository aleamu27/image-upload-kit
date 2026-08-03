import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
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

export async function deleteR2Object(client: S3Client, bucketName: string, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
}
