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

    // Never let list cosmetics re-hide article bodies wrapped in .paywall
    let styles = result.styles || ''
    styles = styles
      .split('\n')
      .filter((line) => !/\.paywall\b|\[class\*="?paywall/i.test(line))
      .join('\n')

    return {
      styles,
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
#ad-banner, #ads, #advertisement,
[aria-label*="advertisement" i],
[class*="newsletter-modal" i],
/* Do NOT hide [class*="paywall"] — many publishers wrap the real article body in .paywall */
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
 * Un-hide article bodies that publishers keep in the DOM but visually gate.
 * WSJ/NYT soft walls often use mask-image gradients (text "fades out") rather
 * than display:none — those must be cleared explicitly, and re-asserted last.
 */
export const CONTENT_REVEAL_CSS = `
/* Nuclear: kill every mask/fade on the page */
html body * {
  -webkit-mask-image: none !important;
  mask-image: none !important;
  -webkit-mask: none !important;
  mask: none !important;
}

/* Show schema/paywall-wrapped article text that is already in the HTML */
.paywall,
[class*="paywall" i],
[class*="Paywall" i],
[itemprop="articleBody"],
[itemprop="articleLead"],
.articleBody,
.article-body,
.article__body,
#mainBody,
main article,
[subscriptions-section="content"],
[subscriptions-display="granted"],
.wsj-snippet-body,
[class*="snippet-body" i],
[class*="SnippetBody" i],
.article-content,
.crawler,
main p, article p, main section, article section {
  display: block !important;
  visibility: visible !important;
  opacity: 1 !important;
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
  filter: none !important;
  -webkit-filter: none !important;
  color: inherit !important;
  -webkit-text-fill-color: unset !important;
  background-clip: border-box !important;
  -webkit-background-clip: border-box !important;
  -webkit-mask-image: none !important;
  mask-image: none !important;
  -webkit-mask: none !important;
  mask: none !important;
}

.paywall *,
[class*="paywall" i] *,
[itemprop="articleBody"] *,
.articleBody *,
.article-body *,
.article__body *,
#mainBody *,
main article *,
.wsj-snippet-body *,
[class*="snippet-body" i] *,
.article-content *,
.crawler *,
main p *, article p * {
  -webkit-mask-image: none !important;
  mask-image: none !important;
  -webkit-mask: none !important;
  mask: none !important;
  opacity: 1 !important;
  filter: none !important;
  max-height: none !important;
  overflow: visible !important;
  -webkit-text-fill-color: unset !important;
  color: inherit !important;
  background-clip: border-box !important;
  -webkit-background-clip: border-box !important;
}

/* Strip common soft-gate overlays without removing the article */
[subscriptions-section="content-not-granted"],
[subscriptions-display="NOT granted"],
[amp-access-hide],
[class*="snippet-promotion" i],
[class*="snippet-overlay" i],
[class*="SnippetOverlay" i],
[class*="dynamic-inset" i][class*="login" i],
[data-testid*="paywall" i],
[data-testid*="subscribe-dialog" i],
[class*="barricade" i],
.wsj-eop-message,
#cx-article-lock-overlay,
#cx-snippet-overlay,
[class*="fade-overlay" i],
[class*="FadeOverlay" i],
[class*="gradient-overlay" i],
[class*="paywall-overlay" i],
[class*="PaywallOverlay" i] {
  display: none !important;
  pointer-events: none !important;
  opacity: 0 !important;
  height: 0 !important;
  max-height: 0 !important;
}

.paywall::before, .paywall::after,
[class*="paywall" i]::before, [class*="paywall" i]::after,
[class*="snippet" i]::before, [class*="snippet" i]::after,
[class*="Snippet" i]::before, [class*="Snippet" i]::after,
article::before, article::after,
[itemprop="articleBody"]::before, [itemprop="articleBody"]::after,
.wsj-snippet-body::before, .wsj-snippet-body::after,
[class*="snippet-body" i]::before, [class*="snippet-body" i]::after,
main::before, main::after {
  display: none !important;
  content: none !important;
  background: none !important;
  opacity: 0 !important;
  -webkit-mask-image: none !important;
  mask-image: none !important;
}

html, body {
  overflow: auto !important;
  height: auto !important;
  position: static !important;
}

/* Clean reader panel — solid text, no site CSS can fade it */
#bf-reader-panel {
  display: block !important;
  visibility: visible !important;
  opacity: 1 !important;
  position: relative !important;
  z-index: 2147483000 !important;
  margin: 56px 12px 24px !important;
  padding: 20px 22px !important;
  max-width: 760px !important;
  background: #f7f4ef !important;
  color: #111 !important;
  border: 1px solid #d5d0c8 !important;
  border-radius: 8px !important;
  font: 18px/1.6 Georgia, "Times New Roman", serif !important;
  -webkit-mask-image: none !important;
  mask-image: none !important;
  filter: none !important;
}
#bf-reader-panel * {
  color: #111 !important;
  opacity: 1 !important;
  -webkit-mask-image: none !important;
  mask-image: none !important;
  background: transparent !important;
  filter: none !important;
  -webkit-text-fill-color: #111 !important;
}
#bf-reader-panel h1 {
  font-size: 28px !important;
  line-height: 1.25 !important;
  margin: 0 0 12px !important;
  font-family: Georgia, serif !important;
}
#bf-reader-panel p {
  margin: 0 0 1em !important;
  display: block !important;
}
#bf-reader-panel .bf-reader-label {
  font: 12px/1.4 system-ui, sans-serif !important;
  color: #666 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.04em !important;
  margin: 0 0 14px !important;
}
`

/** Client-side follow-up for soft gates that re-apply after hydration. */
export const CONTENT_REVEAL_SCRIPT = `
(function() {
  try {
    var STYLE_ID = 'bf-reveal-live';
    var cssText = ${JSON.stringify(
      // re-use same nuclear rules by reading from a marker — inject minimal live sheet
      `html body *{-webkit-mask-image:none!important;mask-image:none!important;-webkit-mask:none!important;mask:none!important;}html,body{overflow:auto!important;}`
    )};

    var ensureStyle = function() {
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        el.setAttribute('data-bf-reveal-live', '1');
      }
      if (el.textContent !== cssText) el.textContent = cssText;
      // Always move to end so we win the cascade against late site CSS
      (document.body || document.documentElement).appendChild(el);
    };

    var hideGate = function(el) {
      try {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
        el.style.setProperty('opacity', '0', 'important');
      } catch (e) {}
    };

    var clearFade = function(el) {
      try {
        var props = {
          'opacity': '1',
          'visibility': 'visible',
          'max-height': 'none',
          'height': 'auto',
          'overflow': 'visible',
          'filter': 'none',
          '-webkit-filter': 'none',
          '-webkit-mask-image': 'none',
          'mask-image': 'none',
          '-webkit-mask': 'none',
          'mask': 'none',
          '-webkit-text-fill-color': 'unset',
          'background-clip': 'border-box',
          '-webkit-background-clip': 'border-box'
        };
        for (var k in props) el.style.setProperty(k, props[k], 'important');
        el.removeAttribute('hidden');
        el.removeAttribute('amp-access-hide');
      } catch (e) {}
    };

    var looksLikeFadeOverlay = function(el) {
      try {
        if (!el || !el.tagName) return false;
        var tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'IMG' || tag === 'SVG' || tag === 'PATH') return false;
        var st = window.getComputedStyle(el);
        if (!st) return false;
        var pos = st.position;
        if (pos !== 'absolute' && pos !== 'fixed' && pos !== 'sticky') return false;
        var bg = (st.backgroundImage || '') + ' ' + (st.background || '');
        var mask = (st.maskImage || st.webkitMaskImage || '') + '';
        var hasGrad = /gradient/i.test(bg) || /gradient/i.test(mask);
        if (!hasGrad && parseFloat(st.opacity) > 0.95) return false;
        var r = el.getBoundingClientRect();
        if (r.height < 30 || r.width < 60) return false;
        // Covering overlays often sit over article mid/bottom
        var txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (txt.length > 180) return false;
        return hasGrad || /subscribe|sign in|continue reading|already a subscriber/i.test(txt);
      } catch (e) { return false; }
    };

    var buildReader = function() {
      try {
        if (document.getElementById('bf-reader-panel')) return;
        var root =
          document.querySelector('[itemprop="articleBody"]') ||
          document.querySelector('article') ||
          document.querySelector('main') ||
          document.querySelector('[class*="paywall" i]') ||
          document.querySelector('[class*="snippet-body" i]');
        if (!root) return;

        var titleEl = document.querySelector('h1');
        var title = titleEl ? (titleEl.innerText || '').trim() : '';
        var parts = [];
        root.querySelectorAll('p, h2, h3, li, [data-type="paragraph"]').forEach(function(n) {
          var t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
          if (t && t.length > 40) parts.push(t);
        });
        if (!parts.length) {
          var blob = (root.innerText || '').replace(/\\s+/g, ' ').trim();
          if (blob.length > 120) parts.push(blob);
        }
        if (!parts.length) return;

        var panel = document.createElement('div');
        panel.id = 'bf-reader-panel';
        panel.setAttribute('data-bf-reader', '1');
        var label = document.createElement('div');
        label.className = 'bf-reader-label';
        label.textContent = 'BrowseFreely reader — extracted article text';
        panel.appendChild(label);
        if (title) {
          var h = document.createElement('h1');
          h.textContent = title;
          panel.appendChild(h);
        }
        parts.forEach(function(t) {
          var p = document.createElement('p');
          p.textContent = t;
          panel.appendChild(p);
        });
        var anchor = document.body || document.documentElement;
        if (anchor.firstChild) anchor.insertBefore(panel, anchor.firstChild);
        else anchor.appendChild(panel);
      } catch (e) {}
    };

    var run = function() {
      try {
        ensureStyle();

        document.querySelectorAll(
          '[subscriptions-section="content-not-granted"],[subscriptions-display="NOT granted"],[amp-access-hide],[data-testid*="paywall" i],[data-testid*="subscribe-dialog" i],#cx-article-lock-overlay,#cx-snippet-overlay,.wsj-eop-message,[class*="snippet-overlay" i],[class*="fade-overlay" i],[class*="gradient-overlay" i],[class*="paywall-overlay" i]'
        ).forEach(hideGate);

        var roots = document.querySelectorAll(
          '.paywall,[class*="paywall" i],[itemprop="articleBody"],[itemprop="articleLead"],.articleBody,.article-body,.article__body,#mainBody,main article,[subscriptions-section="content"],.wsj-snippet-body,[class*="snippet-body" i],.article-content,.crawler,main,article'
        );
        roots.forEach(function(root) {
          clearFade(root);
          try {
            var nodes = root.querySelectorAll('*');
            for (var i = 0; i < nodes.length; i++) {
              var child = nodes[i];
              var stAttr = child.getAttribute('style') || '';
              var cls = child.className && String(child.className) || '';
              if (/mask|opacity|max-height|overflow|gradient|background-clip|text-fill/i.test(stAttr) ||
                  /paywall|snippet|article|crawler|body|fade/i.test(cls)) {
                clearFade(child);
              }
              if (looksLikeFadeOverlay(child)) hideGate(child);
            }
          } catch (e) {}
        });

        // Sweep absolute gradient overlays anywhere
        try {
          document.querySelectorAll('div,span,section,aside').forEach(function(el) {
            if (looksLikeFadeOverlay(el)) hideGate(el);
          });
        } catch (e) {}

        buildReader();

        if (document.documentElement) {
          document.documentElement.style.setProperty('overflow', 'auto', 'important');
        }
        if (document.body) {
          document.body.style.setProperty('overflow', 'auto', 'important');
          document.body.classList.remove('overflow-hidden', 'no-scroll', 'modal-open');
        }
      } catch (e) {}
    };

    run();
    setInterval(run, 700);
    try {
      new MutationObserver(function() { run(); }).observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (e) {}
  } catch (e) {}
})();
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
