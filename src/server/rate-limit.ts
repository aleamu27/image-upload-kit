/**
 * Minimal in-memory, fixed-window rate limiter — same pattern used across
 * this module family (auth-login-kit, form-kit, cookie-consent-kit).
 * Resets on cold start, doesn't coordinate across multiple serverless
 * instances. Fine for blunting casual abuse of an upload endpoint; swap
 * for a shared store (Upstash Redis, or a DB-backed atomic limiter) if
 * that matters for your deployment.
 */

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

export interface RateLimitConfig {
  maxRequests: number
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  retryAfter?: number
}

export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now()
  const bucket = buckets.get(key)

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + config.windowMs })
    return { allowed: true }
  }

  if (bucket.count >= config.maxRequests) {
    return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
  }

  bucket.count += 1
  return { allowed: true }
}

const cleanupInterval = setInterval(
  () => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      if (now > bucket.resetAt) buckets.delete(key)
    }
  },
  10 * 60 * 1000
)
cleanupInterval.unref?.()
