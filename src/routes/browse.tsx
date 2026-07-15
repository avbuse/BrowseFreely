import { Hono, type Context } from 'hono'
import { isValidUrl, isPrivateIP, ensureUrl, safeFetch, tlsOptions } from '../utils/url'
import { mergeBrowseQueryIntoTarget, rewriteHtml } from '../utils/rewriter'
import { isDataDomeChallengePage } from '../utils/botChallenge'
import {
  fetchArchiveSnapshot,
  hostnameIsDowJonesNews,
  looksLikeArticlePath,
  looksLikeSoftPaywallHtml,
} from '../utils/archiveFallback'
import { ensureAdblockerReady, matchAdRequest } from '../utils/adblocker'
import { getSettings } from '../utils/settings'
import { getCookiesForRequest, saveCookiesFromResponse } from '../utils/session'
import { mergeContextResponse } from '../utils/response'

export const browseRoute = new Hono()

function errorPage(title: string, status: number) {
  return (
    <div style={{ color: 'white', background: '#0a0a0f', padding: '20px', height: '100vh' }}>
      <h2>{title}</h2>
      <a href="/" style={{ color: '#3b82f6' }}>
        Try Again
      </a>
    </div>
  )
}

async function handleBrowse(c: Context, method: 'GET' | 'POST') {
  const urlParam = c.req.query('url')

  if (!urlParam) {
    return c.html(errorPage('Error: URL is required', 400), 400)
  }

  let targetUrl = ensureUrl(urlParam)

  // Google-style GET forms submit as /browse?url=https://google.com/search&q=cats
  // Merge sibling params into the upstream URL.
  if (method === 'GET') {
    targetUrl = mergeBrowseQueryIntoTarget(c.req.url, targetUrl)
  }

  if (!isValidUrl(targetUrl)) {
    return c.html(errorPage('Error: Invalid URL', 400), 400)
  }

  if (isPrivateIP(targetUrl)) {
    return c.html(errorPage('Error: Forbidden URL', 403), 403)
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
      'Sec-Fetch-Site': method === 'POST' ? 'same-origin' : 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    }

    if (proxyCookies) {
      fetchHeaders['Cookie'] = proxyCookies
    }

    let body: ArrayBuffer | undefined
    if (method === 'POST') {
      const contentType = c.req.header('content-type') || 'application/x-www-form-urlencoded'
      fetchHeaders['Content-Type'] = contentType
      body = await c.req.arrayBuffer()
    }

    const { response, finalUrl } = await safeFetch(
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

    let htmlText = new TextDecoder().decode(buffer)
    let botChallenge = isDataDomeChallengePage(response, htmlText)
    let rewriteSourceUrl = finalUrl

    // WSJ/Barrons soft teaser: try archive snapshot for fuller HTML (same approach as calibre)
    if (
      !botChallenge &&
      hostnameIsDowJonesNews(finalUrl) &&
      (looksLikeSoftPaywallHtml(htmlText) || looksLikeArticlePath(finalUrl))
    ) {
      const archived = await fetchArchiveSnapshot(finalUrl)
      if (archived && archived.length > Math.max(htmlText.length * 1.1, 20000)) {
        htmlText = archived
        rewriteSourceUrl = finalUrl
        botChallenge = false
        console.log(
          `[browse] Soft paywall on ${finalUrl} — using archive snapshot (${archived.length} bytes)`
        )
      }
    }

    cleanHeaders.set('content-type', 'text/html; charset=utf-8')

    const cleanResponse = new Response(htmlText, {
      status: botChallenge ? response.status : 200,
      statusText: response.statusText,
      headers: cleanHeaders,
    })

    return mergeContextResponse(
      c,
      await rewriteHtml(cleanResponse, rewriteSourceUrl, {
        disableJs: settings.disableJs,
        bypassAdblockDetection: settings.bypassAdblockDetection,
        botChallenge,
      })
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
}

browseRoute.get('/browse', (c) => handleBrowse(c, 'GET'))
browseRoute.post('/browse', (c) => handleBrowse(c, 'POST'))
