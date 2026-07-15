import { Hono, type Context } from 'hono'
import { isValidUrl, isPrivateIP, ensureUrl, safeFetch, tlsOptions } from '../utils/url'
import { ensureAdblockerReady, matchAdRequest } from '../utils/adblocker'
import { getSettings } from '../utils/settings'
import {
  getCookiesForRequest,
  saveCookiesFromResponse,
  responseLooksPrivate,
  getSessionId,
} from '../utils/session'
import { assetCache, cacheKey, isLikelyPublicAsset } from '../utils/cache'
import { getClientIp } from '../utils/clientIp'
import { storageKeyFor } from '../utils/crypto'
import { mergeContextResponse } from '../utils/response'

export const assetRoute = new Hono()

async function handleAsset(c: Context, method: 'GET' | 'POST' | 'PUT' | 'OPTIONS') {
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, X-Requested-With',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  const urlParam = c.req.query('url')
  const referer = c.req.header('referer') || 'https://browsefreely.test'

  if (!urlParam) {
    return c.text('URL is required', 400)
  }

  const targetUrl = ensureUrl(urlParam)

  if (!isValidUrl(targetUrl)) {
    return c.text('Invalid URL', 400)
  }

  if (isPrivateIP(targetUrl)) {
    return c.text('Forbidden URL', 403)
  }

  await ensureAdblockerReady()

  const adMatch = matchAdRequest(targetUrl, referer, c.req.header('accept'))
  if (adMatch.blocked) {
    return adMatch.response
  }

  const sid = getSessionId(c)
  const ip = getClientIp(c)
  const sessionKey = await storageKeyFor(sid, ip)
  const keyed = cacheKey(sessionKey, method + ':' + targetUrl)

  if (method === 'GET') {
    const cached = assetCache.get(keyed)
    if (cached) {
      return mergeContextResponse(
        c,
        new Response(cached.buffer, {
          status: 200,
          headers: {
            'Content-Type': cached.contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'private, max-age=3600',
          },
        })
      )
    }
  }

  const settings = getSettings(c)
  const targetDomain = new URL(targetUrl).hostname
  const proxyCookies = await getCookiesForRequest(c, targetDomain)

  // Prefer upstream page as Referer when our referer is a /browse URL
  let upstreamReferer = 'https://' + targetDomain + '/'
  try {
    const refUrl = new URL(referer)
    const nested = refUrl.searchParams.get('url')
    if (nested) upstreamReferer = nested
    else if (refUrl.hostname === targetDomain) upstreamReferer = referer
  } catch {
    /* keep default */
  }

  try {
    const fetchHeaders: Record<string, string> = {
      'User-Agent': settings.userAgent,
      Accept: c.req.header('accept') || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: upstreamReferer,
      Origin: 'https://' + targetDomain,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    }

    const contentType = c.req.header('content-type')
    if (contentType) fetchHeaders['Content-Type'] = contentType

    if (proxyCookies) {
      fetchHeaders['Cookie'] = proxyCookies
    }

    let body: ArrayBuffer | undefined
    if (method === 'POST' || method === 'PUT') {
      body = await c.req.arrayBuffer()
    }

    const { response } = await safeFetch(
      targetUrl,
      {
        method,
        headers: fetchHeaders,
        body,
        tls: tlsOptions(),
      },
      async (hopUrl, hopResponse) => {
        await saveCookiesFromResponse(c, new URL(hopUrl).hostname, hopResponse)
      }
    )

    // Persist cookies for the page host when APIs set Domain=.site.com
    try {
      const pageHost = new URL(upstreamReferer).hostname
      if (pageHost && pageHost !== targetDomain) {
        await saveCookiesFromResponse(c, pageHost, response)
      }
    } catch {
      /* ignore */
    }

    const cleanHeaders = new Headers(response.headers)
    cleanHeaders.delete('content-encoding')
    cleanHeaders.delete('content-length')
    cleanHeaders.delete('transfer-encoding')
    cleanHeaders.delete('connection')
    cleanHeaders.delete('content-security-policy')
    cleanHeaders.delete('x-frame-options')
    cleanHeaders.delete('set-cookie')

    cleanHeaders.set('Access-Control-Allow-Origin', '*')
    cleanHeaders.set('Access-Control-Allow-Credentials', 'true')

    const buffer = await response.arrayBuffer()
    const ct = response.headers.get('content-type') || 'application/octet-stream'

    const privateResponse = responseLooksPrivate(response, !!proxyCookies)
    if (
      method === 'GET' &&
      response.status === 200 &&
      !privateResponse &&
      isLikelyPublicAsset(ct, targetUrl)
    ) {
      assetCache.set(keyed, { buffer, contentType: ct })
    }

    return mergeContextResponse(
      c,
      new Response(buffer, {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders,
      })
    )
  } catch (e: any) {
    if (e?.message === 'Forbidden URL (SSRF protection)') {
      return c.text('Forbidden URL', 403)
    }
    return c.text(`Asset fetch failed: ${e.message}`, 500)
  }
}

assetRoute.get('/asset', (c) => handleAsset(c, 'GET'))
assetRoute.post('/asset', (c) => handleAsset(c, 'POST'))
assetRoute.put('/asset', (c) => handleAsset(c, 'PUT'))
assetRoute.options('/asset', (c) => handleAsset(c, 'OPTIONS'))
