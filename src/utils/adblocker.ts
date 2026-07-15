import {
  FiltersEngine,
  Request,
  fullLists,
  StreamingHtmlFilter,
} from '@ghostery/adblocker'
import type { RequestType, HTMLSelector } from '@ghostery/adblocker'
import { DATADOME_ALLOW_RULES } from './botChallenge'

let engine: FiltersEngine | null = null
let loading: Promise<FiltersEngine> | null = null

/** Extra annoyance / social / anti-adblock-oriented lists beyond Ghostery "full" */
const EXTRA_LISTS = [
  'https://easylist.to/easylist/fanboy-annoyance.txt',
  'https://easylist.to/easylist/fanboy-social.txt',
  'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
  // uBO anti-adblock + annoyances (raw uAssets — complements Ghostery mirrors)
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-others.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt',
]

/** Future plc / Ad-Shield network rules (tinyShield handles the script integrity layer). */
const ADSHIELD_CUSTOM_RULES = [
  '||cdn.jsdelivr.net/npm/protected-reward-ad@',
  '||cdn.jsdelivr.net/gh/Ad-Shield/*',
  '||ad-shield.io^',
  '||ad-shield.de^',
  '||adshield.club^',
  '||adshield.info^',
  '||refitted.net^',
  '||html-load.com^',
  '||content-loader.com^',
  '||css-load.com^',
  '||22pixx.xyz^',
  '||feload.com^',
  '||bordeaux.futurecdn.net^',
  '||freyr.futurecdn.net^',
  '||vanir.futurecdn.net^',
  '||vanilla.futurecdn.net^$script,domain=windowscentral.com|tomsguide.com|techradar.com|livescience.com|tomshardware.com|gamesradar.com|laptopmag.com|space.com|androidcentral.com|pcgamer.com',
  '||pagead2.googlesyndication.com^$domain=windowscentral.com|tomsguide.com|techradar.com|tomshardware.com|androidcentral.com',
]

/**
 * Allow CMP / privacy-preference scripts that Cookie Monster otherwise blocks.
 * Without these, Sourcepoint (Future plc) and similar consents cannot load or save.
 */
const CMP_ALLOW_RULES = [
  '@@||cdn.privacy-mgmt.com^',
  '@@||privacy-mgmt.com^',
  '@@||message.sp-prod.net^',
  '@@||cms.sp-prod.net^',
  '@@||ccpa-notice.sp-prod.net^',
  '@@||sourcepoint.mgr.consensu.org^',
  '@@||cdn.cookielaw.org^',
  '@@||cdn.cookielaw.org^$script',
  '@@||geolocation.onetrust.com^',
  '@@||consent.cookiebot.com^',
  '@@||consentcdn.cookiebot.com^',
  '@@||vendorlist.consensu.org^',
  '@@||gdpr-wrapper.privacymanager.io^',
  '@@||wrappermessagingwithoutdetection.js^',
]

const TRANSPARENT_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0)
)

export async function getAdblocker(): Promise<FiltersEngine> {
  if (engine) return engine
  if (loading) return loading

  loading = (async () => {
    console.log('[ADBLOCK] Downloading blocklists (ads, tracking, annoyances, anti-adblock)...')
    try {
      engine = await FiltersEngine.fromLists(fetch, [...fullLists, ...EXTRA_LISTS], {
        enableHtmlFiltering: true,
        loadCosmeticFilters: true,
        loadGenericCosmeticsFilters: true,
        loadExtendedSelectors: true,
        enableMutationObserver: true,
        guessRequestTypeFromUrl: true,
      })
      console.log('[ADBLOCK] Blocklists loaded and engine ready')
    } catch (e) {
      console.error('[ADBLOCK] Extended lists failed, falling back to full preset', e)
      try {
        engine = await FiltersEngine.fromPrebuiltFull(fetch)
      } catch (e2) {
        console.error('[ADBLOCK] Failed to load lists, using empty engine', e2)
        engine = FiltersEngine.empty()
      }
    }

    try {
      engine!.updateFromDiff({
        added: [...ADSHIELD_CUSTOM_RULES, ...CMP_ALLOW_RULES, ...DATADOME_ALLOW_RULES],
        removed: [],
      })
      console.log(
        `[ADBLOCK] Applied ${ADSHIELD_CUSTOM_RULES.length} Ad-Shield + ${CMP_ALLOW_RULES.length} CMP + ${DATADOME_ALLOW_RULES.length} DataDome allow rules`
      )
    } catch (err) {
      console.warn('[ADBLOCK] Failed to apply custom rules:', err)
    }

    return engine!
  })()

  return loading
}

/** Ensure lists are loaded before matching (avoids early requests slipping through). */
export async function ensureAdblockerReady(): Promise<void> {
  await getAdblocker()
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

export type BlockDecision =
  | { blocked: false }
  | {
      blocked: true
      /** Prefer silent 200 stubs over 403 — many detectors treat hard failures as "adblock on" */
      response: Response
    }

function stubResponse(url: string, accept?: string | null, redirect?: { body: string; contentType: string }): Response {
  if (redirect) {
    return new Response(redirect.body, {
      status: 200,
      headers: {
        'Content-Type': redirect.contentType,
        'Cache-Control': 'public, max-age=86400',
        'X-BrowseFreely-Blocked': '1',
      },
    })
  }

  const type = guessRequestType(url, accept)
  if (type === 'image' || type === 'media') {
    return new Response(TRANSPARENT_GIF, {
      status: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'public, max-age=86400',
        'X-BrowseFreely-Blocked': '1',
      },
    })
  }
  if (type === 'stylesheet') {
    return new Response('/* blocked */', {
      status: 200,
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'X-BrowseFreely-Blocked': '1',
      },
    })
  }
  if (type === 'script') {
    return new Response('/* blocked */', {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'X-BrowseFreely-Blocked': '1',
      },
    })
  }
  if (type === 'document' || type === 'sub_frame') {
    return new Response('<!doctype html><title></title>', {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'X-BrowseFreely-Blocked': '1',
      },
    })
  }
  return new Response('', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=86400',
      'X-BrowseFreely-Blocked': '1',
    },
  })
}

export function matchAdRequest(
  url: string,
  sourceUrl: string,
  accept?: string | null
): BlockDecision {
  if (!engine) return { blocked: false }

  try {
    const req = Request.fromRawDetails({
      url,
      sourceUrl,
      type: guessRequestType(url, accept),
    })
    const result = engine.match(req)
    if (!result.match) return { blocked: false }

    return {
      blocked: true,
      response: stubResponse(
        url,
        accept,
        result.redirect
          ? { body: result.redirect.body, contentType: result.redirect.contentType }
          : undefined
      ),
    }
  } catch {
    return { blocked: false }
  }
}

/** @deprecated prefer matchAdRequest — kept for simple boolean checks */
export function isAd(url: string, sourceUrl: string, accept?: string | null): boolean {
  return matchAdRequest(url, sourceUrl, accept).blocked
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
 * Apply uBO/Ghostery HTML filtering rules (script-tag removal / replace)
 * to a full HTML document string.
 */
export function applyHtmlFilters(pageUrl: string, html: string): string {
  if (!engine) return html

  try {
    const req = Request.fromRawDetails({
      url: pageUrl,
      type: 'document',
    })
    const selectors: HTMLSelector[] = engine.getHtmlFilters(req)
    if (!selectors.length) return html

    const filter = new StreamingHtmlFilter(selectors)
    let out = filter.write(html)
    out += filter.flush(true)
    return out
  } catch {
    return html
  }
}

/** Aggressive hide for leftover ad slots / overlays (cosmetic lists miss some). */
export const CLEANUP_CSS = `
/* BrowseFreely cleanup — collapse common leftover ad/annoyance chrome */
iframe[id*="google_ads" i],
iframe[src*="doubleclick" i],
iframe[src*="googlesyndication" i],
iframe[id*="ad_" i],
iframe[class*="ad-" i],
ins.adsbygoogle,
[id*="div-gpt-ad" i],
[class*="ad-slot" i],
[class*="adslot" i],
[data-ad-slot],
[data-google-query-id],
.ad-banner, .adbanner, .adsbox, .ad-container, .ads-container,
#ad-banner, #ads, #ad, #advertisement,
[aria-label*="advertisement" i],
[class*="newsletter-modal" i],
[class*="paywall" i],
[class*="adblock-wall" i],
[class*="adblock_wall" i],
[id*="adblock" i][class*="modal" i],
[class*="disable-adblock" i],
[class*="please-disable" i],
.swal-modal, .swal-overlay, .swal2-container,
.ad-blocker-notice, #ad-blocker-notice,
[class*="allow-ads" i], [class*="allowAds" i] {
  display: none !important;
  visibility: hidden !important;
  height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
`

/**
 * Stubs common adblock-detection libraries + bait-element checks.
 * Injected early so detectors see a "clean" environment.
 */
export const ANTI_ADBLOCK_STUB_SCRIPT = `
(function() {
  try {
    var define = function(obj, key, value) {
      try {
        Object.defineProperty(obj, key, { value: value, writable: true, configurable: true });
      } catch (e) {
        try { obj[key] = value; } catch (e2) {}
      }
    };

    define(window, 'canRunAds', true);
    define(window, 'isAdBlockActive', false);
    define(window, 'adblock', false);
    define(window, 'adBlockEnabled', false);
    define(window, 'google_ad_status', 1);
    define(window, 'adsAllowed', true);

    // Google AdSense stub — detectors often check adsbygoogle.loaded
    var adsbygoogle = window.adsbygoogle;
    if (!adsbygoogle || typeof adsbygoogle !== 'object') {
      window.adsbygoogle = { loaded: true, push: function() { return undefined; } };
    } else {
      try { adsbygoogle.loaded = true; } catch (e) {}
      if (typeof adsbygoogle.push !== 'function') {
        adsbygoogle.push = function() { return undefined; };
      }
    }

    // FuckAdBlock / BlockAdBlock API stubs
    var FabStub = function() {
      this.on = function() { return this; };
      this.onDetected = function() { return this; };
      this.onNotDetected = function(cb) { try { cb && cb(); } catch(e) {} return this; };
      this.check = function() { return false; };
      this.setOption = function() { return this; };
    };
    var fab = new FabStub();
    define(window, 'FuckAdBlock', FabStub);
    define(window, 'BlockAdBlock', FabStub);
    define(window, 'SniffAdBlock', FabStub);
    define(window, 'fuckAdBlock', fab);
    define(window, 'blockAdBlock', fab);
    define(window, 'sniffAdBlock', fab);

    // Bait elements: detectors create .adsbox etc. and check getComputedStyle
    var baitCss = document.createElement('style');
    baitCss.setAttribute('data-bf-bait', '1');
    baitCss.textContent = [
      '.adsbox,.ad-box,.ad-container,#ad-banner,#ads,.adsbygoogle,.adbanner,.ad_banner,',
      '.textads,.banner-ad,.pub_300x250,.pub_300x250m,.pub_728x90,.text-ad,.textAd,',
      '.text_ad,.sponsor-ad,.sponsored-ad {',
      '  display: block !important; visibility: visible !important;',
      '  height: 1px !important; width: 1px !important; max-height: 1px !important;',
      '  opacity: 0.01 !important; pointer-events: none !important;',
      '  position: absolute !important; left: -10000px !important; top: -1000px !important;',
      '}'
    ].join('');
    (document.documentElement || document.head || document.body).appendChild(baitCss);

    // Soften getComputedStyle checks on bait-looking nodes
    if (window.getComputedStyle) {
      var origGCS = window.getComputedStyle.bind(window);
      window.getComputedStyle = function(el, pseudo) {
        var style = origGCS(el, pseudo);
        try {
          var id = (el && el.id) || '';
          var cls = (el && el.className && String(el.className)) || '';
          var looksBait = /adsbox|ad-box|adbanner|adsbygoogle|pub_300x250|textads|banner-ad/i.test(id + ' ' + cls);
          if (looksBait) {
            return new Proxy(style, {
              get: function(target, prop) {
                if (prop === 'display') return 'block';
                if (prop === 'visibility') return 'visible';
                if (prop === 'opacity') return '1';
                if (prop === 'height' || prop === 'width') return '1px';
                var v = target[prop];
                return typeof v === 'function' ? v.bind(target) : v;
              }
            });
          }
        } catch (e) {}
        return style;
      };
    }

    // Remove common "please disable adblock" overlays as they appear
    var killOverlays = function() {
      var selectors = [
        '[class*="adblock-wall"]','[class*="adblock_wall"]','[class*="adblock-modal"]',
        '[class*="disable-adblock"]','[class*="please-disable-ad"]','[id*="adblock-detected"]',
        '[class*="adb-wrap"]','[class*="adb_overlay"]','#adblock-notification',
        '.fc-ab-root'
      ];
      try {
        document.querySelectorAll(selectors.join(',')).forEach(function(n) {
          n.style.setProperty('display', 'none', 'important');
          n.remove();
        });
        if (document.documentElement) {
          document.documentElement.style.removeProperty('overflow');
        }
        if (document.body) {
          document.body.style.removeProperty('overflow');
        }
      } catch (e) {}
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', killOverlays);
    } else {
      killOverlays();
    }
    setInterval(killOverlays, 1500);
    try {
      new MutationObserver(killOverlays).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  } catch (e) {}
})();
`

/**
 * Re-apply cosmetic hide rules when the DOM mutates (SPAs inject ads late).
 */
export function buildCosmeticObserverScript(styles: string): string {
  if (!styles) return ''
  const escaped = styles
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
  return `
(function() {
  try {
    var css = \`${escaped}\`;
    var ensure = function() {
      var el = document.getElementById('bf-cosmetics-live');
      if (!el) {
        el = document.createElement('style');
        el.id = 'bf-cosmetics-live';
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== css) el.textContent = css;
    };
    ensure();
    new MutationObserver(ensure).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
})();
`
}
