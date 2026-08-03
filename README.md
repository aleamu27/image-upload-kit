# image-upload-kit

Reusable, hardened image-upload logic for Next.js + Cloudflare R2 —
headless like the rest of this module family: a hook + a thin drag/drop
plumbing component, no fixed styling, no fixed layout. What travels
between projects is the logic (validation, upload strategy, progress,
security checks), not a specific avatar-circle design.

```
src/
  core/          shared image-type allowlist + byte-signature sniffing (client + server)
  hooks/         useImageUpload — the main thing you'll use
  components/    Dropzone — drag/drop + click-to-browse plumbing, render-prop, no styling
  server/        R2 client, byte verification, presigning, rate limiting, request guards

api-route-templates/   four routes to copy in, pick what you need
```

Only `react` is required for the client side. `next` / `@aws-sdk/client-s3`
/ `@aws-sdk/s3-request-presigner` are only needed if you copy in the
server route templates.

## Where this came from

Extracted from a real-estate site's R2 upload stack (`r2-client.ts` +
`api/upload/image/route.ts` + `avatar-upload.tsx`). Concrete issues found
and fixed:

- **File type was trusted, never verified.** The route checked `file.type.startsWith('image/')` — a browser-reported (or outright client-claimed) value, not the actual file content. A renamed `.html`/`.exe` claiming to be `image/png` would sail through. This module sniffs the real byte signature both client-side (fast first check) and server-side (the actual gate) instead.
- **A real production R2 account ID was hardcoded as a fallback** in `r2-client.ts`, alongside a "just mock it and return a fake URL" pattern when env vars were missing — silently serving broken image links instead of failing loudly. This version throws immediately with exactly which env var is missing.
- **The 10MB size check couldn't actually be reached for larger files on Vercel** — Vercel's default Node.js Serverless Function body limit is ~4.5MB, well below what the code implied was supported. This module ships both a proxy route (simple, verifies bytes inline, sized for that ceiling) and a presigned-direct-to-R2 route (not bound by it) — see "Which upload mode" below.
- **No rate limiting** on the upload endpoint.
- **No real upload progress** — the original used `fetch`, which can't report upload progress; this uses XHR.
- **Preview used `FileReader.readAsDataURL`**, which base64-encodes the whole file into memory. Swapped for `URL.createObjectURL` (cheaper) with proper revocation on replace/reset/unmount.
- **Drag-over state flickered** on any project using a naive `dragenter`/`dragleave` toggle once the drop zone had nested elements (as the original did) — fixed with a drag-enter counter in `Dropzone`.

A second pass over this module itself (not the original) turned up more:

- **Selecting a new file while a previous upload was still in flight raced.** The old XHR reference just got overwritten — the earlier upload kept running in the background, could still resolve and fire `onSuccess` with stale data, and `abort()`/`reset()` only ever controlled the newest one. `selectFile` now aborts anything in flight before starting, and every async step checks a request token so a superseded operation can't write state even if it had already resolved before `abort()` took effect.
- **`onSuccess`/`allowedTypes` broke memoization** the same way an earlier version of `cookie-consent-kit` did — passing an inline function/array (as this README's own examples do) gave `selectFile` a new identity every render. Now read from a ref that's kept current via an effect, not closed over directly.
- **`maxSizeMB` was never actually enforced in presign mode.** The presign route only checks the client's *claimed* `fileSize` before issuing the URL — nothing about a presigned PUT caps what a client can then upload directly to R2. `confirm-upload-route.ts` now reads the object's real, server-reported size (`HeadObjectCommand`) and deletes it if it exceeds the limit, the same way it already did for byte-signature verification.
- **A non-image file still got a broken preview shown next to its error.** `validate()` now distinguishes "not an image at all" (clears the preview) from "a real image that's just too big/wrong type" (keeps it, so the error has context).
- **The presign and confirm requests weren't abortable** — only the XHR upload phase was. `abort()` now cancels whichever phase is active via an `AbortController`.
- **The proxy route's size pre-check could be skipped** by omitting `Content-Length`, and `request.formData()` fully buffers the body regardless of any pre-check anyway (a hard platform limitation of the Web Request API, not something this module can work around). It now also checks `file.size` — the runtime's actual buffered value, not a header — immediately after parsing and before allocating a second buffer via `arrayBuffer()`.
- **A transient R2 read failure right after upload would delete a genuinely valid image.** `confirm-upload-route.ts`'s verification read is now retried (3 attempts, backoff) before concluding the upload is invalid.

## Install

Source-only, no build step — copy this folder into your project, or:

```bash
npm install git+https://github.com/<you>/image-upload-kit.git
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

## Which upload mode

| | `mode: 'proxy'` (default) | `mode: 'presign'` |
|---|---|---|
| File passes through your server | Yes | No — direct browser → R2 |
| Server verifies real bytes | Inline, before storing | After the fact, via `confirmEndpoint` |
| Size ceiling | Your host's serverless body limit (~4.5MB on Vercel) | Whatever you set — not bound by that limit |
| Setup | 1 route | 2 routes (presign + confirm) |

Start with `proxy` unless you specifically need larger files.

## Usage

```tsx
'use client'
import { useImageUpload, Dropzone } from 'image-upload-kit'

export function AvatarUploader() {
  const { preview, status, progress, errorMessage, selectFile, reset } = useImageUpload({
    endpoint: '/api/upload/image', // proxy mode (default)
    maxSizeMB: 4,
    onSuccess: ({ url }) => {
      // save `url` wherever it belongs in your app
    },
  })

  return (
    <Dropzone onFileSelected={selectFile}>
      {({ isDragging, openFileDialog }) => (
        <div onClick={openFileDialog} style={{ cursor: 'pointer', opacity: isDragging ? 0.7 : 1 }}>
          {preview ? <img src={preview} alt="Preview" width={128} height={128} /> : <p>Click or drag an image</p>}
          {status === 'uploading' && <progress value={progress} max={100} />}
          {status === 'error' && <p>{errorMessage}</p>}
          {status === 'success' && <button onClick={reset}>Upload another</button>}
        </div>
      )}
    </Dropzone>
  )
}
```

For large files, switch to presign mode — same hook, two extra props:

```tsx
useImageUpload({
  mode: 'presign',
  endpoint: '/api/upload/presign',
  confirmEndpoint: '/api/upload/confirm',
  maxSizeMB: 15,
})
```

### Server setup

1. Copy `.env.example` into your app's `.env.local` and fill in your R2 credentials (Cloudflare dashboard → R2 → Manage R2 API Tokens).
2. Copy whichever route template(s) you need:
   - `api-route-templates/proxy-upload-route.ts` → `app/api/upload/image/route.ts`
   - `api-route-templates/presign-upload-route.ts` → `app/api/upload/presign/route.ts`
   - `api-route-templates/confirm-upload-route.ts` → `app/api/upload/confirm/route.ts` (presign mode only)
   - `api-route-templates/delete-route.ts` → `app/api/upload/delete/route.ts` (optional)
3. Add your own auth check where each template's `TODO` marks it — none of these assume a particular auth system.

## What's in the logic layer

- **`useImageUpload`** — byte-signature validation (client-side first pass), object-URL preview with automatic cleanup, real upload progress + cancellation via XHR, and both upload strategies behind one API.
- **`Dropzone`** — drag/drop + click-to-browse event plumbing, drag-counter based (no flicker), a render prop for full control over markup.
- **`sniffImageMimeType`** (shared core) — the same byte-signature check used client-side and server-side, so "does this look like a real image" is answered identically in both places.
- **`validateImageBuffer`** (server) — the authoritative check: size + real content type, ignoring whatever the client claimed.
- **`createR2Client` / `loadR2ConfigFromEnv`** (server) — throws with the exact missing env var name instead of silently mocking.
- **`createPresignedUpload` / `fetchObjectHeadBytes` / `fetchObjectSize` / `deleteR2Object`** (server) — the presign-mode building blocks, including the "read back just enough bytes, and the real size, to verify" trick `confirm-upload-route.ts` uses.
- **`checkRateLimit` / `isRequestTooLarge` / `getClientIP`** (server) — used by all four route templates.

## Security notes

- **SVG is deliberately not in the allowed type list.** SVGs can embed `<script>` and are a well-known stored-XSS vector when user-uploaded and served back to other visitors. Add SVG support only with a dedicated sanitizer (e.g. DOMPurify's SVG mode) in front of it — never accept raw SVG bytes.
- **Presign mode has inherent gaps that `confirmEndpoint` closes**: a presigned PUT URL constrains the `Content-Type` header (via the request signature) but the storage layer doesn't sniff actual bytes, and doesn't cap upload size either — without the confirm step, a client could PUT non-image bytes under a spoofed-but-signature-matching Content-Type, or a file far larger than what it claimed when requesting the URL. Don't skip `confirmEndpoint` in presign mode.
- **`getClientIP`/rate limiting assumes a trusted proxy** (see its doc comment) — spoofable if self-hosted without one.

## Ideas to make it more robust

- **Client-side image compression/resize before upload** (canvas-based) to cut bandwidth and R2 storage costs — not included, since the right target dimensions/quality are very project-specific.
- **Strip EXIF metadata** (GPS location, device info) before storing, if uploads might include photos taken on a phone.
- **Swap the in-memory rate limiter for a shared store** if you deploy to multiple serverless instances — same caveat as the sibling modules in this family.
- **Reject decompression-bomb-style images** (small file size, absurd pixel dimensions) if you ever process/resize uploads server-side — this module only checks byte size and format, not decoded dimensions.

## License

MIT
