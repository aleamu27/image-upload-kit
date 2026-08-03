import { S3Client } from '@aws-sdk/client-s3'

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucketName: string
  /** Base URL images are served from — R2's public bucket URL, or a custom domain/CDN in front of it. No trailing slash. */
  publicUrl: string
}

/**
 * Reads R2 credentials from env vars and throws immediately if any are
 * missing, rather than silently falling back to a mock client that
 * returns fake URLs. A misconfigured upload feature should fail loudly in
 * development, not quietly serve broken image links in production.
 */
export function loadR2ConfigFromEnv(): R2Config {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucketName = process.env.R2_BUCKET_NAME
  const publicUrl = process.env.R2_PUBLIC_URL

  const missing = [
    !accountId && 'R2_ACCOUNT_ID',
    !accessKeyId && 'R2_ACCESS_KEY_ID',
    !secretAccessKey && 'R2_SECRET_ACCESS_KEY',
    !bucketName && 'R2_BUCKET_NAME',
    !publicUrl && 'R2_PUBLIC_URL',
  ].filter(Boolean)

  if (missing.length > 0) {
    throw new Error(`[image-upload-kit] Missing R2 env vars: ${missing.join(', ')}. See .env.example.`)
  }

  return {
    accountId: accountId!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    bucketName: bucketName!,
    publicUrl: publicUrl!.replace(/\/$/, ''),
  }
}

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}
