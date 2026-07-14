import { Hono } from 'hono'
import { isValidUrl, isPrivateIP, ensureUrl, safeFetch, tlsOptions } from '../utils/url'
import { isAd } from '../utils/adblocker'
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

assetRoute.get('/asset', async (c) => {
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

  if (isAd(targetUrl, referer, c.req.header('accept'))) {
    return c.text('', 403)
  }

  const sid = getSessionId(c)
  const ip = getClientIp(c)
  const sessionKey = await storageKeyFor(sid, ip)
  const keyed = cacheKey(sessionKey, targetUrl)

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

  const settings = getSettings(c)
  const targetDomain = new URL(targetUrl).hostname
  const proxyCookies = await getCookiesForRequest(c, targetDomain)

  try {
    const fetchHeaders: Record<string, string> = {
      'User-Agent': settings.userAgent,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.5',
    }

    if (proxyCookies) {
      fetchHeaders['Cookie'] = proxyCookies
    }

    const { response } = await safeFetch(
      targetUrl,
      {
        method: 'GET',
        headers: fetchHeaders,
        tls: tlsOptions(),
      },
      async (hopUrl, hopResponse) => {
        await saveCookiesFromResponse(c, new URL(hopUrl).hostname, hopResponse)
      }
    )

    const cleanHeaders = new Headers(response.headers)
    cleanHeaders.delete('content-encoding')
    cleanHeaders.delete('content-length')
    cleanHeaders.delete('transfer-encoding')
    cleanHeaders.delete('connection')
    cleanHeaders.delete('content-security-policy')
    cleanHeaders.delete('x-frame-options')
    cleanHeaders.delete('set-cookie')

    cleanHeaders.set('Access-Control-Allow-Origin', '*')

    const buffer = await response.arrayBuffer()
    const contentType = response.headers.get('content-type') || 'application/octet-stream'

    const privateResponse = responseLooksPrivate(response, !!proxyCookies)
    if (
      response.status === 200 &&
      !privateResponse &&
      isLikelyPublicAsset(contentType, targetUrl)
    ) {
      assetCache.set(keyed, { buffer, contentType })
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
})
