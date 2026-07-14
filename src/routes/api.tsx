import { Hono } from 'hono'
import { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { clearSession, getSessionId } from '../utils/session'

export const apiRoute = new Hono()

function cookieSecure(c: Context): boolean {
  if (process.env.SECURE_COOKIES === 'true') return true
  if (process.env.SECURE_COOKIES === 'false') return false
  try {
    return new URL(c.req.url).protocol === 'https:'
  } catch {
    return false
  }
}

apiRoute.post('/api/settings', async (c) => {
  const body = await c.req.parseBody()
  const settings = {
    userAgent: body.userAgent as string,
    disableJs: body.disableJs === 'true',
    bypassAdblockDetection: body.bypassAdblockDetection === 'true',
  }

  setCookie(c, 'bf_settings', encodeURIComponent(JSON.stringify(settings)), {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    secure: cookieSecure(c),
    sameSite: 'Lax',
  })

  return c.redirect('/')
})

apiRoute.get('/api/clear-session', async (c) => {
  getSessionId(c)
  await clearSession(c)
  return c.redirect('/')
})
