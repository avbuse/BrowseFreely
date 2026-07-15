/**
 * Bot-challenge helpers (DataDome, etc.) for proxied pages.
 */

export function isDataDomeResponse(response: Response, html?: string): boolean {
  const h = (name: string) => response.headers.get(name) || ''
  if (h('x-datadome') || h('x-dd-b')) return true
  if (html) return htmlLooksLikeDataDomeChallenge(html)
  return false
}

export function htmlLooksLikeDataDomeChallenge(html: string): boolean {
  if (/var\s+dd\s*=\s*\{/i.test(html)) return true
  if (/captcha-delivery\.com/i.test(html) && /Please enable JS and disable any ad blocker/i.test(html)) {
    return true
  }
  if (/geo\.captcha-delivery\.com/i.test(html) && /datadome/i.test(html)) return true
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
