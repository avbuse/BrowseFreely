/**
 * Bot-challenge helpers (DataDome, etc.) for proxied pages.
 */

/**
 * True only for an actual interstitial/captcha challenge page.
 *
 * IMPORTANT: Do NOT key off `x-datadome` alone — DataDome sets that header on
 * normal 200 article responses too. Treating those as challenges skipped our
 * content-reveal CSS (WSJ soft-paywall fade never cleared).
 */
export function isDataDomeChallengePage(response: Response, html?: string): boolean {
  const status = response.status
  const looksChallenge = html ? htmlLooksLikeDataDomeChallenge(html) : false

  // Classic soft/hard challenge interstitial
  if (looksChallenge) return true

  // Blocked responses that are still serving the DD interstitial body
  if ((status === 401 || status === 403 || status === 429) && htmlHasDataDomeMarker(html)) {
    return true
  }

  return false
}

/** @deprecated use isDataDomeChallengePage — kept name for call sites during transition */
export function isDataDomeResponse(response: Response, html?: string): boolean {
  return isDataDomeChallengePage(response, html)
}

function htmlHasDataDomeMarker(html?: string): boolean {
  if (!html) return false
  return (
    /var\s+dd\s*=\s*\{/i.test(html) ||
    /captcha-delivery\.com/i.test(html) ||
    /datadome/i.test(html)
  )
}

export function htmlLooksLikeDataDomeChallenge(html: string): boolean {
  if (/var\s+dd\s*=\s*\{/i.test(html) && /captcha-delivery\.com/i.test(html)) return true
  if (/Please enable JS and disable any ad blocker/i.test(html)) return true
  if (/captcha-delivery\.com/i.test(html) && /id=["']cmsg["']/i.test(html)) return true
  if (/geo\.captcha-delivery\.com/i.test(html) && /var\s+dd\s*=/i.test(html)) return true
  return false
}

/** Hosts that must reach the browser for soft/hard DataDome challenges. */
export const DATADOME_ALLOW_RULES = [
  '@@||datadome.co^',
  '@@||js.datadome.co^',
  '@@||api-js.datadome.co^',
  '@@||api.datadome.co^',
  '@@||captcha-delivery.com^',
  '@@||ct.captcha-delivery.com^',
  '@@||geo.captcha-delivery.com^',
  '@@||dd.nytimes.com^',
]
