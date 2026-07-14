import { Hono } from 'hono'
import { isValidUrl, isPrivateIP, ensureUrl, safeFetch, tlsOptions } from '../utils/url'
import { rewriteHtml } from '../utils/rewriter'
import { ensureAdblockerReady, matchAdRequest } from '../utils/adblocker'
import { getSettings } from '../utils/settings'
import { getCookiesForRequest, saveCookiesFromResponse } from '../utils/session'
import { mergeContextResponse } from '../utils/response'

export const browseRoute = new Hono()

browseRoute.get('/browse', async (c) => {
  const urlParam = c.req.query('url')

  if (!urlParam) {
    return c.html(
      <div style={{ color: 'white', background: '#0a0a0f', padding: '20px', height: '100vh' }}>
        <h2>Error: URL is required</h2>
        <a href="/" style={{ color: '#3b82f6' }}>
          Try Again
        </a>
      </div>,
      400
    )
  }

  const targetUrl = ensureUrl(urlParam)

  if (!isValidUrl(targetUrl)) {
    return c.html(
      <div style={{ color: 'white', background: '#0a0a0f', padding: '20px', height: '100vh' }}>
        <h2>Error: Invalid URL</h2>
        <a href="/" style={{ color: '#3b82f6' }}>
          Try Again
        </a>
      </div>,
      400
    )
  }

  if (isPrivateIP(targetUrl)) {
    return c.html(
      <div style={{ color: 'white', background: '#0a0a0f', padding: '20px', height: '100vh' }}>
        <h2>Error: Forbidden URL</h2>
        <a href="/" style={{ color: '#3b82f6' }}>
          Try Again
        </a>
      </div>,
      403
    )
  }

  await ensureAdblockerReady()

  const adMatch = matchAdRequest(
    targetUrl,
    c.req.header('referer') || targetUrl,
    c.req.header('accept')
  )
  if (adMatch.blocked) {
    return adMatch.response
  }

  const settings = getSettings(c)
  const targetDomain = new URL(targetUrl).hostname
  const proxyCookies = await getCookiesForRequest(c, targetDomain)

  try {
    const fetchHeaders: Record<string, string> = {
      'User-Agent': settings.userAgent,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    }

    if (proxyCookies) {
      fetchHeaders['Cookie'] = proxyCookies
    }

    const { response, finalUrl } = await safeFetch(
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

    const contentType = response.headers.get('content-type') || ''
    const isHtml = contentType.includes('text/html')

    const cleanHeaders = new Headers(response.headers)
    cleanHeaders.delete('content-encoding')
    cleanHeaders.delete('content-length')
    cleanHeaders.delete('transfer-encoding')
    cleanHeaders.delete('connection')
    cleanHeaders.delete('content-security-policy')
    cleanHeaders.delete('x-frame-options')
    cleanHeaders.delete('set-cookie')

    // Do not blanket-CORS HTML documents
    if (!isHtml) {
      cleanHeaders.set('Access-Control-Allow-Origin', '*')
    }

    const buffer = await response.arrayBuffer()

    if (!isHtml) {
      return mergeContextResponse(
        c,
        new Response(buffer, {
          status: response.status,
          headers: cleanHeaders,
        })
      )
    }

    cleanHeaders.set('content-type', 'text/html; charset=utf-8')

    const cleanResponse = new Response(buffer, {
      status: response.status,
      statusText: response.statusText,
      headers: cleanHeaders,
    })

    return mergeContextResponse(
      c,
      await rewriteHtml(
        cleanResponse,
        finalUrl,
        settings.disableJs,
        settings.bypassAdblockDetection
      )
    )
  } catch (e: any) {
    const msg = e?.message === 'Forbidden URL (SSRF protection)' ? e.message : 'Failed to fetch URL'
    return c.html(
      <div
        style={{
          color: 'white',
          background: '#0a0a0f',
          padding: '20px',
          height: '100vh',
          fontFamily: 'sans-serif',
        }}
      >
        <h2>{msg}</h2>
        {e?.message && e.message !== msg ? <p>{e.message}</p> : null}
        <br />
        <a
          href="/"
          style={{
            padding: '10px 20px',
            background: '#3b82f6',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '5px',
          }}
        >
          Try Again
        </a>
      </div>,
      e?.message === 'Forbidden URL (SSRF protection)' ? 403 : 500
    )
  }
})
