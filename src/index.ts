// Client-safe exports only. Server-only helpers (R2 client, byte-signature
// verification, presigning, rate limiting, request guards) live in
// src/server/ and are imported directly by API route handlers — see
// api-route-templates/.

export { ALLOWED_IMAGE_TYPES, sniffImageMimeType, type ImageTypeInfo } from './core/image-types'

export {
  useImageUpload,
  type UseImageUploadOptions,
  type UseImageUploadResult,
  type UploadStatus,
} from './hooks/useImageUpload'

export { Dropzone, type DropzoneProps } from './components/Dropzone'
