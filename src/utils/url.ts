export function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function hostnameIsPrivate(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (host === 'localhost' || host === '::1') return true

  // IPv4-mapped IPv6 (::ffff:127.0.0.1 / ::ffff:7f00:1)
  const v4Mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (v4Mapped) return hostnameIsPrivate(v4Mapped[1])
  const v4MappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16)
    const lo = parseInt(v4MappedHex[2], 16)
    const a = (hi >> 8) & 0xff
    const b = hi & 0xff
    const c = (lo >> 8) & 0xff
    const d = lo & 0xff
    return hostnameIsPrivate(`${a}.${b}.${c}.${d}`)
  }

  // Unique-local / link-local IPv6
  if (
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80') ||
    host === '0:0:0:0:0:0:0:1'
  ) {
    return true
  }

  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
  const match = host.match(ipv4Regex)
  if (match) {
    const parts = host.split('.').map(Number)
    if (parts.some((p) => p > 255)) return true
    if (parts[0] === 0) return true // 0.0.0.0/8
    if (parts[0] === 127) return true
    if (parts[0] === 10) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true // CGNAT
  }

  // Cloud metadata / internal resolver hostnames
  const blockedHostnames = new Set([
    'metadata.google.internal',
    'metadata.goog',
    'metadata',
    'kubernetes.default',
    'kubernetes.default.svc',
  ])
  if (blockedHostnames.has(host)) return true
  if (host.endsWith('.internal') || host.endsWith('.localhost')) return true

  return false
}

/**
 * Returns true if the URL targets a private/local/metadata address.
 * Honors ALLOW_PRIVATE_TARGETS=true for intentional LAN browsing via the proxy.
 */
export function isPrivateIP(urlString: string): boolean {
  if (process.env.ALLOW_PRIVATE_TARGETS === 'true') {
    return false
  }

  try {
    const url = new URL(urlString)
    return hostnameIsPrivate(url.hostname)
  } catch {
    return true
  }
}

export function ensureUrl(input: string): string {
  input = input.trim()

  if (!input.includes('.') || input.includes(' ')) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(input)}&ia=web`
  }

  if (!input.startsWith('http://') && !input.startsWith('https://')) {
    return 'https://' + input
  }
  return input
}

export function encodeUrl(url: string): string {
  return encodeURIComponent(url)
}

export function resolveUrl(baseUrl: string, targetUrl: string): string {
  try {
    if (
      targetUrl.startsWith('javascript:') ||
      targetUrl.startsWith('mailto:') ||
      targetUrl.startsWith('data:') ||
      targetUrl.startsWith('#')
    ) {
      return targetUrl
    }
    return new URL(targetUrl, baseUrl).href
  } catch {
    return targetUrl
  }
}

export function tlsOptions(): { rejectUnauthorized: boolean } | undefined {
  // Default secure; allow opt-out for broken corporate MITM / self-signed LAN hosts
  if (process.env.INSECURE_TLS === 'true') {
    return { rejectUnauthorized: false }
  }
  return { rejectUnauthorized: true }
}

export type SafeFetchResult = {
  response: Response
  finalUrl: string
}

export type SafeFetchHopHandler = (hopUrl: string, response: Response) => void | Promise<void>

/**
 * Fetch that re-validates SSRF on every redirect hop.
 * Optional onHop runs for every response (including intermediate redirects)
 * so callers can persist Set-Cookie before the body is drained.
 */
export async function safeFetch(
  targetUrl: string,
  init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {},
  onHop?: SafeFetchHopHandler
): Promise<SafeFetchResult> {
  const maxRedirects = 10
  let current = targetUrl

  for (let i = 0; i <= maxRedirects; i++) {
    if (!isValidUrl(current) || isPrivateIP(current)) {
      throw new Error('Forbidden URL (SSRF protection)')
    }

    const response = await fetch(current, {
      ...init,
      redirect: 'manual',
      tls: init.tls ?? tlsOptions(),
    } as any)

    if (onHop) {
      await onHop(current, response)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return { response, finalUrl: current }
      current = new URL(location, current).href
      try {
        await response.arrayBuffer()
      } catch {
        /* ignore */
      }
      continue
    }

    return { response, finalUrl: current }
  }

  throw new Error('Too many redirects')
}
