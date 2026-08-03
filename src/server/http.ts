export const MAX_JSON_BODY_BYTES = 20_000

/** Soft check via Content-Length — rejects an obviously oversized payload/file before it's parsed. */
export function isRequestTooLarge(request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): boolean {
  const contentLength = request.headers.get('content-length')
  if (!contentLength) return false
  return Number(contentLength) > maxBytes
}

/**
 * Best-effort client IP. Prefers `x-vercel-forwarded-for`, which Vercel's
 * edge network sets itself and a client cannot override, before falling
 * back to the generic `x-forwarded-for` / `x-real-ip` headers — those are
 * only trustworthy behind a proxy that actually strips client-supplied
 * values before setting its own. Behind an untrusted or missing proxy, a
 * client can set these headers directly and spoof any IP, defeating
 * IP-based rate limiting.
 */
export function getClientIP(request: Request): string {
  const vercelIP = request.headers.get('x-vercel-forwarded-for')
  if (vercelIP) return vercelIP.split(',')[0].trim()

  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()

  return request.headers.get('x-real-ip') || 'unknown'
}
