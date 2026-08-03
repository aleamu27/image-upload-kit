'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ALLOWED_IMAGE_TYPES, sniffImageMimeType } from '../core/image-types'

export type UploadStatus = 'idle' | 'validating' | 'uploading' | 'success' | 'error'

export interface UseImageUploadOptions {
  /**
   * 'proxy': the file is sent through your own API route, which verifies
   * its actual bytes before storing it — simplest option, but keep files
   * well under your host's serverless body-size limit (Vercel's default
   * is ~4.5MB for Node.js Functions).
   *
   * 'presign': the browser uploads directly to R2 using a short-lived
   * signed URL your server issues — not bound by that size ceiling, but
   * your server never sees the file's bytes during the upload itself, so
   * pair this with `confirmEndpoint` to verify them afterwards.
   *
   * Default: 'proxy'.
   */
  mode?: 'proxy' | 'presign'
  /**
   * 'proxy' mode: receives the file as multipart form data, returns `{ url, key }`.
   * 'presign' mode: receives `{ fileName, fileType, fileSize }`, returns `{ uploadUrl, publicUrl, key }`.
   * Default '/api/upload/image'.
   */
  endpoint?: string
  /** 'presign' mode only — verifies the object's real bytes after the client's PUT completes. Default '/api/upload/confirm'. Pass null to skip (not recommended). */
  confirmEndpoint?: string | null
  maxSizeMB?: number
  allowedTypes?: string[]
  onSuccess?: (result: { url: string; key: string }) => void
}

export interface UseImageUploadResult {
  /** Object URL for the currently selected file. Revoked automatically on replace/reset/unmount. */
  preview: string | null
  status: UploadStatus
  /** 0-100. Reflects real upload progress (via XHR) during the 'uploading' phase. */
  progress: number
  errorMessage: string | null
  selectFile: (file: File) => Promise<void>
  /** Cancels an in-flight upload. */
  abort: () => void
  reset: () => void
}

const DEFAULT_MAX_SIZE_MB = 10
const DEFAULT_ALLOWED_TYPES = Object.keys(ALLOWED_IMAGE_TYPES)

function uploadViaXHR(
  url: string,
  method: string,
  body: XMLHttpRequestBodyInit,
  onXHRCreated: (xhr: XMLHttpRequest) => void,
  onProgress: (percent: number) => void,
  headers?: Record<string, string>
): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    onXHRCreated(xhr)
    xhr.open(method, url)
    if (headers) Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value))

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : {})
        } catch {
          resolve({})
        }
        return
      }
      let message = `Upload failed (${xhr.status})`
      try {
        const parsed = JSON.parse(xhr.responseText)
        if (parsed?.error) message = parsed.error
      } catch {
        // Non-JSON error body (e.g. a platform error page) — keep the generic message.
      }
      reject(new Error(message))
    }

    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'))

    xhr.send(body)
  })
}

/**
 * Handles file validation (real byte-signature sniffing, not just the
 * browser-reported MIME type), an efficient object-URL preview with proper
 * cleanup, upload with real progress and cancellation, and both upload
 * strategies (proxy or presigned-direct-to-R2). No assumption about
 * styling or markup — pair with <Dropzone> or your own drag/drop-zone.
 */
export function useImageUpload(options?: UseImageUploadOptions): UseImageUploadResult {
  const mode = options?.mode ?? 'proxy'
  const endpoint = options?.endpoint ?? '/api/upload/image'
  const confirmEndpoint = options?.confirmEndpoint === null ? null : options?.confirmEndpoint ?? '/api/upload/confirm'
  const maxSizeMB = options?.maxSizeMB ?? DEFAULT_MAX_SIZE_MB
  const allowedTypes = options?.allowedTypes ?? DEFAULT_ALLOWED_TYPES
  const onSuccess = options?.onSuccess

  const [preview, setPreview] = useState<string | null>(null)
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const previewUrlRef = useRef<string | null>(null)
  const xhrRef = useRef<XMLHttpRequest | null>(null)

  const setPreviewFile = useCallback((file: File | null) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    if (file) {
      const url = URL.createObjectURL(file)
      previewUrlRef.current = url
      setPreview(url)
    } else {
      setPreview(null)
    }
  }, [])

  // Revoke on unmount too, not just on the next selection/reset.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  const validate = useCallback(
    async (file: File): Promise<string | null> => {
      if (file.size === 0) return 'File is empty'
      if (file.size > maxSizeMB * 1024 * 1024) return `File must be smaller than ${maxSizeMB}MB`

      // Sniff real bytes rather than trusting file.type — a renamed file
      // claiming to be an image would otherwise sail through. This is a
      // fast first line of defense; the server (proxy mode inline, or
      // confirmEndpoint in presign mode) repeats it as the real gate.
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
      const sniffed = sniffImageMimeType(head)
      if (!sniffed) return 'This file is not a recognized image format'
      if (!allowedTypes.includes(sniffed)) return `${sniffed} images are not allowed here`

      return null
    },
    [maxSizeMB, allowedTypes]
  )

  const selectFile = useCallback(
    async (file: File) => {
      setErrorMessage(null)
      setProgress(0)
      setStatus('validating')
      setPreviewFile(file)

      const validationError = await validate(file)
      if (validationError) {
        setErrorMessage(validationError)
        setStatus('error')
        return
      }

      setStatus('uploading')

      try {
        if (mode === 'proxy') {
          const formData = new FormData()
          formData.append('file', file)
          const result = await uploadViaXHR(
            endpoint,
            'POST',
            formData,
            (xhr) => (xhrRef.current = xhr),
            setProgress
          )
          xhrRef.current = null
          setStatus('success')
          onSuccess?.(result)
        } else {
          const presignRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: file.name, fileType: file.type, fileSize: file.size }),
          })
          if (!presignRes.ok) {
            const body = await presignRes.json().catch(() => ({}))
            throw new Error(body?.error || 'Could not start upload')
          }
          const { uploadUrl, publicUrl, key } = await presignRes.json()

          await uploadViaXHR(
            uploadUrl,
            'PUT',
            file,
            (xhr) => (xhrRef.current = xhr),
            setProgress,
            { 'Content-Type': file.type }
          )
          xhrRef.current = null

          // The presigned PUT never let the server see the file's actual
          // content — ask it to verify now that the bytes are in R2.
          if (confirmEndpoint) {
            const confirmRes = await fetch(confirmEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key }),
            })
            if (!confirmRes.ok) {
              const body = await confirmRes.json().catch(() => ({}))
              throw new Error(body?.error || 'Uploaded file failed verification')
            }
          }

          setStatus('success')
          onSuccess?.({ url: publicUrl, key })
        }
      } catch (error: any) {
        xhrRef.current = null
        if (error?.name === 'AbortError') {
          setStatus('idle')
          return
        }
        setErrorMessage(error?.message || 'Upload failed. Please try again.')
        setStatus('error')
      }
    },
    [mode, endpoint, confirmEndpoint, validate, onSuccess, setPreviewFile]
  )

  const abort = useCallback(() => {
    xhrRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    xhrRef.current?.abort()
    xhrRef.current = null
    setPreviewFile(null)
    setStatus('idle')
    setProgress(0)
    setErrorMessage(null)
  }, [setPreviewFile])

  return { preview, status, progress, errorMessage, selectFile, abort, reset }
}
