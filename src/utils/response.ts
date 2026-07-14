import type { Context } from 'hono'

/**
 * Merge Set-Cookie (and other) headers already staged on the Hono context
 * into a raw Response. Needed because returning `new Response(...)` skips
 * Hono's normal cookie flush.
 */
export function mergeContextResponse(c: Context, res: Response): Response {
  const headers = new Headers(res.headers)

  c.res.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      headers.append('set-cookie', value)
    }
  })

  // Hono may expose getSetCookie
  const staged = (c.res.headers as any).getSetCookie?.() as string[] | undefined
  if (staged) {
    for (const cookie of staged) {
      if (![...headers.entries()].some(([k, v]) => k.toLowerCase() === 'set-cookie' && v === cookie)) {
        headers.append('set-cookie', cookie)
      }
    }
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}
