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
  /** 'presign' mode only — verifies the object's real bytes (and size) after the client's PUT completes. Default '/api/upload/confirm'. Pass null to skip (not recommended). */
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
  /** Cancels whatever's currently in flight — the presign request, the upload itself, or the confirm request. */
  abort: () => void
  reset: () => void
}

const DEFAULT_MAX_SIZE_MB = 10
const DEFAULT_ALLOWED_TYPES = Object.keys(ALLOWED_IMAGE_TYPES)

type ActiveOperation = { kind: 'xhr'; xhr: XMLHttpRequest } | { kind: 'fetch'; controller: AbortController } | null

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

async function fetchJSON(url: string, body: unknown, signal: AbortSignal): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}))
    throw new Error(errorBody?.error || `Request failed (${response.status})`)
  }
  return response.json()
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

  const [preview, setPreview] = useState<string | null>(null)
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const previewUrlRef = useRef<string | null>(null)
  const activeOperation = useRef<ActiveOperation>(null)
  // Bumped on every selectFile()/reset() call — lets an in-flight async
  // operation notice it's been superseded and bail out silently instead of
  // overwriting state with a stale result, even if abort() didn't manage
  // to stop it in time (e.g. it had already resolved).
  const requestToken = useRef(0)

  // Read via .current inside callbacks instead of closing over the option
  // directly, so selectFile's own identity doesn't change just because a
  // caller passed a fresh inline array/function on every render (as this
  // module's own README usage examples do for onSuccess).
  const onSuccessRef = useRef(options?.onSuccess)
  const allowedTypesRef = useRef(options?.allowedTypes ?? DEFAULT_ALLOWED_TYPES)
  useEffect(() => {
    onSuccessRef.current = options?.onSuccess
  }, [options?.onSuccess])
  useEffect(() => {
    allowedTypesRef.current = options?.allowedTypes ?? DEFAULT_ALLOWED_TYPES
  }, [options?.allowedTypes])

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

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  const abort = useCallback(() => {
    const op = activeOperation.current
    if (op?.kind === 'xhr') op.xhr.abort()
    else if (op?.kind === 'fetch') op.controller.abort()
  }, [])

  /**
   * Sniffs the real bytes rather than trusting file.type — a renamed file
   * claiming to be an image would otherwise sail through. This is a fast
   * first line of defense; the server (proxy mode inline, or
   * confirmEndpoint in presign mode) repeats it as the real gate.
   *
   * Distinguishes "not an image at all" from "a real image that's just
   * too big/wrong type" so selectFile can decide whether the preview is
   * still worth keeping around next to the error.
   */
  const validate = useCallback(
    async (file: File): Promise<{ error: string | null; isRecognizedImage: boolean }> => {
      if (file.size === 0) return { error: 'File is empty', isRecognizedImage: false }

      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
      const sniffed = sniffImageMimeType(head)
      if (!sniffed) return { error: 'This file is not a recognized image format', isRecognizedImage: false }

      if (file.size > maxSizeMB * 1024 * 1024) {
        return { error: `File must be smaller than ${maxSizeMB}MB`, isRecognizedImage: true }
      }
      if (!allowedTypesRef.current.includes(sniffed)) {
        return { error: `${sniffed} images are not allowed here`, isRecognizedImage: true }
      }

      return { error: null, isRecognizedImage: true }
    },
    [maxSizeMB]
  )

  const selectFile = useCallback(
    async (file: File) => {
      // A new selection always wins — stop whatever was running and make
      // sure it can't overwrite state after this call has moved on.
      abort()
      const myToken = ++requestToken.current

      setErrorMessage(null)
      setProgress(0)
      setStatus('validating')

      const { error: validationError, isRecognizedImage } = await validate(file)
      if (requestToken.current !== myToken) return // superseded while validating

      setPreviewFile(isRecognizedImage ? file : null)

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
            (xhr) => (activeOperation.current = { kind: 'xhr', xhr }),
            setProgress
          )
          if (requestToken.current !== myToken) return
          activeOperation.current = null
          setStatus('success')
          onSuccessRef.current?.(result)
        } else {
          const presignController = new AbortController()
          activeOperation.current = { kind: 'fetch', controller: presignController }
          const { uploadUrl, publicUrl, key } = await fetchJSON(
            endpoint,
            { fileName: file.name, fileType: file.type, fileSize: file.size },
            presignController.signal
          )
          if (requestToken.current !== myToken) return

          await uploadViaXHR(
            uploadUrl,
            'PUT',
            file,
            (xhr) => (activeOperation.current = { kind: 'xhr', xhr }),
            setProgress,
            { 'Content-Type': file.type }
          )
          if (requestToken.current !== myToken) return

          // The presigned PUT never let the server see the file's actual
          // content (or verify its real size) — ask it to check now that
          // the bytes are in R2.
          if (confirmEndpoint) {
            const confirmController = new AbortController()
            activeOperation.current = { kind: 'fetch', controller: confirmController }
            await fetchJSON(confirmEndpoint, { key }, confirmController.signal)
            if (requestToken.current !== myToken) return
          }

          activeOperation.current = null
          setStatus('success')
          onSuccessRef.current?.({ url: publicUrl, key })
        }
      } catch (error: any) {
        activeOperation.current = null
        if (requestToken.current !== myToken) return // a newer selection already took over
        if (error?.name === 'AbortError') {
          setStatus('idle')
          return
        }
        setErrorMessage(error?.message || 'Upload failed. Please try again.')
        setStatus('error')
      }
    },
    [mode, endpoint, confirmEndpoint, validate, abort, setPreviewFile]
  )

  const reset = useCallback(() => {
    requestToken.current += 1 // invalidate anything still in flight
    abort()
    activeOperation.current = null
    setPreviewFile(null)
    setStatus('idle')
    setProgress(0)
    setErrorMessage(null)
  }, [abort, setPreviewFile])

  return { preview, status, progress, errorMessage, selectFile, abort, reset }
}
