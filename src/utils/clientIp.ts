import type { Context } from 'hono'

/**
 * Resolve the client IP for session binding and rate limiting.
 *
 * On LAN self-host (default): prefer the socket peer injected by Bun as
 * `x-bf-client-ip`, ignoring spoofable forwarded headers.
 * Set TRUST_PROXY=true only when behind a trusted reverse proxy.
 */
export function getClientIp(c: Context): string {
  const trustProxy = process.env.TRUST_PROXY === 'true'

  if (trustProxy) {
    const cf = c.req.header('cf-connecting-ip')
    if (cf) return cf.trim()

    const xff = c.req.header('x-forwarded-for')
    if (xff) return xff.split(',')[0].trim()
  }

  // Set by our Bun.serve wrapper; never trust a client-supplied value blindly —
  // the wrapper overwrites this on every request.
  const peer = c.req.header('x-bf-client-ip')
  if (peer) return peer.trim()

  return '127.0.0.1'
}
