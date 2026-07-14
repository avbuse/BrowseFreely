import { FiltersEngine, Request } from '@ghostery/adblocker'
import type { RequestType } from '@ghostery/adblocker'

let engine: FiltersEngine | null = null
let loading: Promise<FiltersEngine> | null = null

export async function getAdblocker(): Promise<FiltersEngine> {
  if (engine) return engine
  if (loading) return loading

  loading = (async () => {
    console.log('[ADBLOCK] Downloading full blocklists (ads + tracking + annoyances)...')
    try {
      // Full preset includes annoyances / anti-adblock oriented rules
      engine = await FiltersEngine.fromPrebuiltFull(fetch)
      console.log('[ADBLOCK] Blocklists loaded and engine ready')
    } catch (e) {
      console.error('[ADBLOCK] Full lists failed, falling back to ads+tracking', e)
      try {
        engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch)
      } catch (e2) {
        console.error('[ADBLOCK] Failed to load lists, using empty engine', e2)
        engine = FiltersEngine.empty()
      }
    }
    return engine
  })()

  return loading
}

export function guessRequestType(url: string, accept?: string | null): RequestType {
  const a = (accept || '').toLowerCase()
  if (a.includes('text/css')) return 'stylesheet'
  if (a.includes('image/')) return 'image'
  if (a.includes('font/') || a.includes('application/font')) return 'font'
  if (a.includes('text/html')) return 'document'

  const path = url.split('?')[0].toLowerCase()
  if (/\.css$/i.test(path)) return 'stylesheet'
  if (/\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i.test(path)) return 'image'
  if (/\.(woff2?|ttf|otf|eot)$/i.test(path)) return 'font'
  if (/\.(mp4|webm|mkv|mp3|ogg|wav)$/i.test(path)) return 'media'
  if (/\.(js|mjs|jsx|ts)$/i.test(path)) return 'script'
  if (/\.(html?|php|asp|aspx)$/i.test(path)) return 'document'
  return 'xhr'
}

export function isAd(url: string, sourceUrl: string, accept?: string | null): boolean {
  if (!engine) return false

  try {
    const req = Request.fromRawDetails({
      url,
      sourceUrl,
      type: guessRequestType(url, accept),
    })
    return engine.match(req).match
  } catch {
    return false
  }
}

export type CosmeticPayload = {
  styles: string
  scripts: string[]
}

export function getCosmeticsForUrl(pageUrl: string): CosmeticPayload {
  if (!engine) return { styles: '', scripts: [] }

  try {
    const parsed = new URL(pageUrl)
    const hostname = parsed.hostname
    // tldts is used internally; domain can be hostname for our purposes if null
    const result = engine.getCosmeticsFilters({
      url: pageUrl,
      hostname,
      domain: hostname,
      getBaseRules: true,
      getInjectionRules: true,
      getExtendedRules: false,
      getRulesFromDOM: false,
      getRulesFromHostname: true,
    })

    return {
      styles: result.styles || '',
      scripts: result.scripts || [],
    }
  } catch {
    return { styles: '', scripts: [] }
  }
}

/**
 * Stubs common adblock-detection globals so paywalled / "disable adblock" walls
 * are less likely to fire when network ads are already stripped by the proxy.
 */
export const ANTI_ADBLOCK_STUB_SCRIPT = `
(function() {
  try {
    Object.defineProperty(window, 'canRunAds', { value: true, writable: true, configurable: true });
    Object.defineProperty(window, 'isAdBlockActive', { value: false, writable: true, configurable: true });
    Object.defineProperty(window, 'adblock', { value: false, writable: true, configurable: true });
    Object.defineProperty(window, 'adBlockEnabled', { value: false, writable: true, configurable: true });
    window.adsbygoogle = window.adsbygoogle || { loaded: true, push: function() { return undefined; } };
    if (typeof window.adsbygoogle === 'object') {
      window.adsbygoogle.loaded = true;
    }
    // Some detectors look for bait elements being hidden
    var style = document.createElement('style');
    style.textContent = '.adsbox, .ad-box, .ad-container, #ad-banner, #ads, .adsbygoogle { display: block !important; height: 1px !important; width: 1px !important; opacity: 0.01 !important; pointer-events: none !important; position: absolute !important; left: -9999px !important; }';
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}
})();
`
