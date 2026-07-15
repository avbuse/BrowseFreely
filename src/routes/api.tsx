import { Hono } from 'hono'
import { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { clearSession, getSessionId, setJarCookie } from '../utils/session'
import { getSettings } from '../utils/settings'
import { getClientIp } from '../utils/clientIp'
import {
  buildBrokenSiteReport,
  listBrokenSiteReports,
  saveBrokenSiteReport,
} from '../utils/reports'
import { createBrokenSiteIssue, githubIssuesConfigured } from '../utils/githubIssues'

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

  setCookie(c, 'bf_settings', JSON.stringify(settings), {
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
 * Persist a document.cookie write from a proxied page into the encrypted jar
 * for the upstream hostname (needed for DataDome / auth cookies).
 */
apiRoute.post('/api/jar-cookie', async (c) => {
  getSessionId(c)
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400)
  }

  const domain = String(body.domain || '').trim()
  const name = String(body.name || '').trim()
  const value = String(body.value ?? '')

  if (!domain || !name || name.length > 128 || domain.length > 253) {
    return c.json({ ok: false, error: 'bad params' }, 400)
  }
  // Only allow cookie names we care about for bot/auth, plus short generic names
  if (!/^[A-Za-z0-9_._-]+$/.test(name)) {
    return c.json({ ok: false, error: 'bad name' }, 400)
  }
  if (value.length > 8192) {
    return c.json({ ok: false, error: 'value too long' }, 400)
  }

  try {
    const host = new URL(domain.includes('://') ? domain : `https://${domain}`).hostname
    await setJarCookie(c, host, name, value)
    // Mirror onto registrable-ish parent (wsj.com) for Domain=.wsj.com semantics
    const parts = host.split('.')
    if (parts.length > 2) {
      await setJarCookie(c, parts.slice(-2).join('.'), name, value)
    }
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false, error: 'failed' }, 500)
  }
})

/**
 * Log a site that broke (anti-adblock wall, blank page, etc.) for later investigation.
 * Works via plain form POST so it still works with NoScript.
 * Also opens a GitHub issue when GITHUB_TOKEN is configured.
 */
apiRoute.post('/api/report-broken', async (c) => {
  const body = await c.req.parseBody()
  const url = String(body.url || '').trim()
  const note = String(body.note || '').trim().slice(0, 500)

  if (!url) {
    return c.text('URL is required', 400)
  }

  const settings = getSettings(c)
  const report = buildBrokenSiteReport({
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

  const gh = await createBrokenSiteIssue(report)
  if (gh.ok) {
    report.githubIssueUrl = gh.url
    report.githubIssueNumber = gh.number
    console.log(`[REPORT] GitHub issue #${gh.number}: ${gh.url}`)
  } else {
    report.githubError = gh.reason
    console.warn(`[REPORT] GitHub issue not created: ${gh.reason}`)
  }

  await saveBrokenSiteReport(report)

  const qs = new URLSearchParams({ logged: '1', url })
  if (gh.ok) {
    qs.set('issue', String(gh.number))
    qs.set('issue_url', gh.url)
  } else if (!githubIssuesConfigured()) {
    qs.set('gh', 'unconfigured')
  } else {
    qs.set('gh', 'error')
  }
  return c.redirect(`/reports?${qs.toString()}`)
})

apiRoute.get('/api/reports', async (c) => {
  const reports = await listBrokenSiteReports()
  return c.json({
    count: reports.length,
    githubConfigured: githubIssuesConfigured(),
    reports,
  })
})
