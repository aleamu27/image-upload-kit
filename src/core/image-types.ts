export interface ImageTypeInfo {
  extension: string
}

// Deliberately excludes SVG: SVG files can embed <script> and are a
// classic stored-XSS vector when user-uploaded and served back to other
// visitors. If a project genuinely needs SVG uploads, sanitize server-side
// with a dedicated library (e.g. DOMPurify's SVG mode) rather than
// accepting raw SVG bytes through this module.
export const ALLOWED_IMAGE_TYPES: Record<string, ImageTypeInfo> = {
  'image/jpeg': { extension: 'jpg' },
  'image/png': { extension: 'png' },
  'image/webp': { extension: 'webp' },
  'image/gif': { extension: 'gif' },
}

/**
 * Identifies an image format from its actual byte signature ("magic
 * bytes"), never from the filename or a claimed Content-Type — both are
 * fully attacker-controlled. Only needs the first ~16 bytes of the file,
 * so it's cheap to run client-side before upload and server-side after.
 */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50 // "WEBP"
  ) {
    return 'image/webp'
  }
  return null
}
