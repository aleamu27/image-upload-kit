import { ALLOWED_IMAGE_TYPES, sniffImageMimeType } from '../core/image-types'

export interface ValidateImageOptions {
  maxSizeBytes: number
  allowedMimeTypes?: string[]
}

export interface ValidateImageResult {
  ok: boolean
  error?: string
  mimeType?: string
  extension?: string
}

/**
 * Verifies actual file content via its byte signature — never the
 * client-supplied filename or Content-Type, both of which are entirely
 * attacker-controlled. This is the real gate; the client-side check in
 * useImageUpload is only a fast first line of defense, not a substitute.
 */
export function validateImageBuffer(bytes: Uint8Array, options: ValidateImageOptions): ValidateImageResult {
  if (bytes.byteLength === 0) return { ok: false, error: 'File is empty' }
  if (bytes.byteLength > options.maxSizeBytes) {
    return { ok: false, error: `File exceeds ${Math.round(options.maxSizeBytes / (1024 * 1024))}MB limit` }
  }

  const sniffed = sniffImageMimeType(bytes)
  if (!sniffed) return { ok: false, error: 'File is not a recognized image format' }

  const allowed = options.allowedMimeTypes ?? Object.keys(ALLOWED_IMAGE_TYPES)
  if (!allowed.includes(sniffed)) return { ok: false, error: `${sniffed} images are not allowed here` }

  return { ok: true, mimeType: sniffed, extension: ALLOWED_IMAGE_TYPES[sniffed].extension }
}
