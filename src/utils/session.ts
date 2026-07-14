import { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { getClientIp } from './clientIp'
import { decryptText, encryptText, storageKeyFor, type EncryptedBlob } from './crypto'

type SessionRecord = {
  /** Encrypted cookie string per target hostname */
  cookies: Map<string, EncryptedBlob>
  updatedAt: number
}

// In-memory encrypted jar keyed by hash(sessionId|clientIp)
const sessions = new Map<string, SessionRecord>()

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 // 24h idle

function cookieSecure(c: Context): boolean {
  if (process.env.SECURE_COOKIES === 'true') return true
  if (process.env.SECURE_COOKIES === 'false') return false
  try {
    return new URL(c.req.url).protocol === 'https:'
  } catch {
    return false
  }
}

function pruneExpired() {
  const now = Date.now()
  for (const [key, rec] of sessions) {
    if (now - rec.updatedAt > SESSION_TTL_MS) {
      sessions.delete(key)
    }
  }
}

export function getSessionId(c: Context): string {
  let sid = getCookie(c, 'bf_session')
  if (!sid) {
    sid = crypto.randomUUID()
    setCookie(c, 'bf_session', sid, {
      path: '/',
      httpOnly: true,
      secure: cookieSecure(c),
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 30,
    })
  }
  return sid
}

async function getStorageKey(c: Context): Promise<{ sid: string; key: string; ip: string }> {
  const sid = getSessionId(c)
  const ip = getClientIp(c)
  const key = await storageKeyFor(sid, ip)
  return { sid, key, ip }
}

function touch(rec: SessionRecord) {
  rec.updatedAt = Date.now()
}

export async function getCookiesForRequest(c: Context, domain: string): Promise<string> {
  pruneExpired()
  const { key } = await getStorageKey(c)
  const rec = sessions.get(key)
  if (!rec) return ''
  touch(rec)
  const blob = rec.cookies.get(domain)
  if (!blob) return ''
  return (await decryptText(blob)) || ''
}

export async function saveCookiesFromResponse(
  c: Context,
  domain: string,
  response: Response
): Promise<void> {
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : []
  if (!setCookies || setCookies.length === 0) return

  const { key } = await getStorageKey(c)
  let rec = sessions.get(key)
  if (!rec) {
    rec = { cookies: new Map(), updatedAt: Date.now() }
    sessions.set(key, rec)
  }
  touch(rec)

  const existingStr = rec.cookies.has(domain)
    ? (await decryptText(rec.cookies.get(domain)!)) || ''
    : ''

  const existingCookies = new Map<string, string>()
  existingStr.split(';').forEach((part) => {
    const parts = part.split('=')
    if (parts.length >= 2) {
      existingCookies.set(parts[0].trim(), parts.slice(1).join('=').trim())
    }
  })

  for (const raw of setCookies) {
    const mainPart = raw.split(';')[0]
    const parts = mainPart.split('=')
    if (parts.length >= 2) {
      const name = parts[0].trim()
      const value = parts.slice(1).join('=').trim()
      // Deletion: Max-Age=0 / empty value
      if (value === '' || /max-age=0/i.test(raw) || /expires=thu,\s*01[-\s]jan[-\s]1970/i.test(raw)) {
        existingCookies.delete(name)
      } else {
        existingCookies.set(name, value)
      }
    }
  }

  const newCookieStr = Array.from(existingCookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')

  if (!newCookieStr) {
    rec.cookies.delete(domain)
  } else {
    rec.cookies.set(domain, await encryptText(newCookieStr))
  }
}

export async function clearSession(c: Context): Promise<void> {
  const { key } = await getStorageKey(c)
  sessions.delete(key)
}

/** True if this response used (or set) cookies — used to avoid cross-user cache leaks */
export function responseLooksPrivate(response: Response, hadRequestCookies: boolean): boolean {
  if (hadRequestCookies) return true
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : []
  if (setCookies && setCookies.length > 0) return true
  const cc = (response.headers.get('cache-control') || '').toLowerCase()
  if (cc.includes('private') || cc.includes('no-store')) return true
  return false
}
