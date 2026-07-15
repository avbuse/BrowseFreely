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

function normalizeHost(host: string): string {
  return host.replace(/^\./, '').toLowerCase()
}

/** Host + parent domains (www.wsj.com → wsj.com). */
export function cookieLookupHosts(hostname: string): string[] {
  const host = normalizeHost(hostname)
  const out: string[] = [host]
  const parts = host.split('.')
  for (let i = 1; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join('.'))
  }
  // Always try eTLD+1 style last two labels when longer
  if (parts.length >= 2) {
    const base = parts.slice(-2).join('.')
    if (!out.includes(base)) out.push(base)
  }
  return out
}

function parseCookieMap(existingStr: string): Map<string, string> {
  const existingCookies = new Map<string, string>()
  existingStr.split(';').forEach((part) => {
    const parts = part.split('=')
    if (parts.length >= 2) {
      existingCookies.set(parts[0].trim(), parts.slice(1).join('=').trim())
    }
  })
  return existingCookies
}

async function writeCookieMap(
  rec: SessionRecord,
  domain: string,
  map: Map<string, string>
): Promise<void> {
  const host = normalizeHost(domain)
  const newCookieStr = Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  if (!newCookieStr) {
    rec.cookies.delete(host)
  } else {
    rec.cookies.set(host, await encryptText(newCookieStr))
  }
}

export async function getCookiesForRequest(c: Context, domain: string): Promise<string> {
  pruneExpired()
  const { key } = await getStorageKey(c)
  const rec = sessions.get(key)
  if (!rec) return ''
  touch(rec)

  // Merge cookies from host + parent jar keys (DataDome often Domain=.wsj.com)
  const merged = new Map<string, string>()
  for (const host of cookieLookupHosts(domain).reverse()) {
    const blob = rec.cookies.get(host)
    if (!blob) continue
    const str = (await decryptText(blob)) || ''
    for (const [k, v] of parseCookieMap(str)) {
      merged.set(k, v)
    }
  }
  return Array.from(merged.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

async function upsertCookiesOnHost(
  c: Context,
  domain: string,
  pairs: Array<{ name: string; value: string; deleted?: boolean }>
): Promise<void> {
  const { key } = await getStorageKey(c)
  let rec = sessions.get(key)
  if (!rec) {
    rec = { cookies: new Map(), updatedAt: Date.now() }
    sessions.set(key, rec)
  }
  touch(rec)

  const host = normalizeHost(domain)
  const existingStr = rec.cookies.has(host)
    ? (await decryptText(rec.cookies.get(host)!)) || ''
    : ''
  const map = parseCookieMap(existingStr)

  for (const p of pairs) {
    if (p.deleted || p.value === '') {
      map.delete(p.name)
    } else {
      map.set(p.name, p.value)
    }
  }
  await writeCookieMap(rec, host, map)
}

/**
 * Store a cookie from client-side document.cookie (proxied pages) into the jar
 * for the upstream site hostname.
 */
export async function setJarCookie(
  c: Context,
  domain: string,
  name: string,
  value: string
): Promise<void> {
  await upsertCookiesOnHost(c, domain, [{ name, value, deleted: value === '' }])
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

  // Group by Domain attribute when present (e.g. Domain=.wsj.com from DataDome APIs)
  const byHost = new Map<string, Array<{ name: string; value: string; deleted: boolean }>>()

  const addTo = (host: string, name: string, value: string, deleted: boolean) => {
    const h = normalizeHost(host)
    if (!byHost.has(h)) byHost.set(h, [])
    byHost.get(h)!.push({ name, value, deleted })
  }

  for (const raw of setCookies) {
    const mainPart = raw.split(';')[0]
    const parts = mainPart.split('=')
    if (parts.length < 2) continue
    const name = parts[0].trim()
    const value = parts.slice(1).join('=').trim()
    const deleted =
      value === '' || /max-age=0/i.test(raw) || /expires=thu,\s*01[-\s]jan[-\s]1970/i.test(raw)

    const domainMatch = raw.match(/;\s*domain=([^;]+)/i)
    const cookieDomain = domainMatch ? domainMatch[1].trim() : domain
    addTo(cookieDomain, name, value, deleted)
    // Also mirror onto response host so exact-host lookups still work
    if (normalizeHost(cookieDomain) !== normalizeHost(domain)) {
      addTo(domain, name, value, deleted)
    }
  }

  for (const [host, pairs] of byHost) {
    const existingStr = rec.cookies.has(host)
      ? (await decryptText(rec.cookies.get(host)!)) || ''
      : ''
    const map = parseCookieMap(existingStr)
    for (const p of pairs) {
      if (p.deleted) map.delete(p.name)
      else map.set(p.name, p.value)
    }
    await writeCookieMap(rec, host, map)
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
