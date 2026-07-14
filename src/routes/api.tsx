import { Hono } from 'hono'
import { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { clearSession, getSessionId } from '../utils/session'
import { getSettings } from '../utils/settings'
import { getClientIp } from '../utils/clientIp'
import { appendBrokenSiteReport, listBrokenSiteReports } from '../utils/reports'

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

/**
 * Log a site that broke (anti-adblock wall, blank page, etc.) for later investigation.
 * Works via plain form POST so it still works with NoScript.
 */
apiRoute.post('/api/report-broken', async (c) => {
  const body = await c.req.parseBody()
  const url = String(body.url || '').trim()
  const note = String(body.note || '').trim().slice(0, 500)

  if (!url) {
    return c.text('URL is required', 400)
  }

  const settings = getSettings(c)
  await appendBrokenSiteReport({
    url,
    note,
    settings: {
      disableJs: settings.disableJs,
      bypassAdblockDetection: settings.bypassAdblockDetection,
      userAgent: settings.userAgent,
    },
    client: {
      userAgent: c.req.header('user-agent') || '',
      ip: getClientIp(c),
    },
  })

  const qs = new URLSearchParams({ logged: '1', url })
  return c.redirect(`/reports?${qs.toString()}`)
})

apiRoute.get('/api/reports', async (c) => {
  const reports = await listBrokenSiteReports()
  return c.json({ count: reports.length, reports })
})
