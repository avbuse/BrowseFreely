import { resolveUrl } from './url'
import { TopBar } from '../components/TopBar'
import { FINGERPRINT_SPOOF_SCRIPT } from './fingerprint'
import {
  ANTI_ADBLOCK_STUB_SCRIPT,
  CLEANUP_CSS,
  CONTENT_REVEAL_CSS,
  CONTENT_REVEAL_SCRIPT,
  applyHtmlFilters,
  buildCosmeticObserverScript,
  getCosmeticsForUrl,
} from './adblocker'
import { buildNavigationGuardScript } from './navigationGuard'
import {
  FUTURE_ADSHIELD_PREP_SCRIPT,
  isAdShieldLoaderUrl,
  neutralizeAdShieldConfig,
  shouldInjectAdShieldPrep,
  shouldInjectTinyShield,
} from './tinyshield'
import { htmlLooksLikeDataDomeChallenge } from './botChallenge'

function escapeForJsString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/<\//g, '<\\/')
}

export type RewriteOptions = {
  disableJs?: boolean
  bypassAdblockDetection?: boolean
  /** Soften injections so DataDome / captcha challenges can run in-page */
  botChallenge?: boolean
}

function buildCookieSyncScript(safeBaseUrl: string): string {
  return `
(function() {
  try {
    var base = '${safeBaseUrl}';
    var host = '';
    try { host = new URL(base).hostname; } catch (e) { return; }

    var sync = function(name, value) {
      if (!name) return;
      // Always sync bot/auth cookies; also sync short session-ish names
      if (!/^(datadome|dd_|__cf|cf_|session|auth|token|jwt|sid|uid)/i.test(name) && name.length > 40) return;
      try {
        fetch('/api/jar-cookie', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: host, name: name, value: value == null ? '' : String(value) }),
          credentials: 'same-origin',
          keepalive: true
        }).catch(function(){});
      } catch (e) {}
    };

    var desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
               Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
    if (!desc || !desc.set) return;
    var rawSet = desc.set;
    var rawGet = desc.get;
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      enumerable: true,
      get: function() { return rawGet.call(document); },
      set: function(v) {
        try {
          var s = String(v || '');
          var nv = s.split(';')[0];
          var eq = nv.indexOf('=');
          if (eq > 0) {
            var n = nv.slice(0, eq).trim();
            var val = nv.slice(eq + 1).trim();
            sync(n, val);
          }
        } catch (e) {}
        return rawSet.call(document, v);
      }
    });
  } catch (e) {}
})();
`
}

function buildFetchAndXhrProxyScript(safeBaseUrl: string): string {
  return `
(function() {
  var base = '${safeBaseUrl}';
  function isDirectBotHost(abs) {
    try {
      var h = new URL(abs).hostname.toLowerCase();
      return /(^|\\.)(datadome\\.co|captcha-delivery\\.com)$/.test(h);
    } catch (e) { return false; }
  }
  function proxyUrl(u) {
    try {
      if (!u || typeof u !== 'string') return u;
      if (u.indexOf('/browse') === 0 || u.indexOf('/asset') === 0 || u.indexOf('/api/') === 0 || u.indexOf('/bf/') === 0) return u;
      if (u.charAt(0) === '#' || /^(javascript|mailto|tel|data):/i.test(u)) return u;
      var abs = new URL(u, base).href;
      if (abs.indexOf('http') !== 0) return u;
      // Real browser TLS + user IP for DataDome / captcha CDNs
      if (isDirectBotHost(abs)) return abs;
      return '/asset?url=' + encodeURIComponent(abs);
    } catch (e) { return u; }
  }

  var originalFetch = window.fetch;
  window.fetch = function() {
    var input = arguments[0];
    if (typeof input === 'string') {
      arguments[0] = proxyUrl(input);
    } else if (input && typeof input === 'object' && typeof input.url === 'string') {
      try {
        var proxied = proxyUrl(input.url);
        if (proxied !== input.url) {
          arguments[0] = new Request(proxied, input);
        }
      } catch (e) {}
    }
    return originalFetch.apply(this, arguments);
  };

  // DataDome challenge uses XHR POSTs — proxy those too (except DD hosts)
  if (window.XMLHttpRequest) {
    var rawOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try {
        if (typeof url === 'string') arguments[1] = proxyUrl(url);
      } catch (e) {}
      return rawOpen.apply(this, arguments);
    };
  }
})();
`
}

export async function rewriteHtml(
  htmlStream: ReadableStream | Response,
  baseUrl: string,
  disableJsOrOpts: boolean | RewriteOptions = false,
  bypassAdblockDetectionArg: boolean = true
): Promise<Response> {
  const opts: RewriteOptions =
    typeof disableJsOrOpts === 'object' && disableJsOrOpts
      ? disableJsOrOpts
      : {
          disableJs: !!disableJsOrOpts,
          bypassAdblockDetection: bypassAdblockDetectionArg,
        }

  let disableJs = !!opts.disableJs
  const bypassAdblockDetection = opts.bypassAdblockDetection !== false
  let botChallenge = !!opts.botChallenge

  const source = htmlStream instanceof Response ? htmlStream : new Response(htmlStream)
  let html = await source.text()

  if (!botChallenge && htmlLooksLikeDataDomeChallenge(html)) {
    botChallenge = true
  }
  // Challenges cannot run without JS
  if (botChallenge) disableJs = false

  const topBarHtml = TopBar({ currentUrl: baseUrl, disableJs }).toString()
  const safeBaseUrl = escapeForJsString(baseUrl)

  const cosmetics = botChallenge ? { styles: '', scripts: [] as string[] } : getCosmeticsForUrl(baseUrl)

  if (!botChallenge) {
    html = applyHtmlFilters(baseUrl, html)
  }

  // Prefer removing Ad-Shield / Future detection over fighting it in-page.
  if (bypassAdblockDetection && !botChallenge) {
    html = neutralizeAdShieldConfig(html)
  }

  const rewriter = new HTMLRewriter()
  let topBarInjected = false

  const injectTopBar = (el: { prepend: (html: string, opts: { html: boolean }) => void }) => {
    if (topBarInjected) return
    topBarInjected = true
    el.prepend(topBarHtml, { html: true })
    el.prepend('<div data-bf-spacer style="height: 48px; width: 100%;"></div>', { html: true })
  }

  rewriter.on('body', {
    element(el) {
      injectTopBar(el)
    },
  })

  // Fallback for odd documents without <body>
  rewriter.on('html', {
    element(el) {
      // If body handler already ran this is a no-op via flag; if no body, prepend here
      el.append(
        `<script data-bf-topbar-fallback>
          (function(){
            if(document.querySelector('[data-bf-topbar]')) return;
            var s=document.createElement('div');
            s.innerHTML=${JSON.stringify(topBarHtml)};
            var bar=s.firstElementChild;
            if(bar){ bar.setAttribute('data-bf-topbar','1'); document.documentElement.appendChild(bar); }
          })();
        </script>`,
        { html: true }
      )
    },
  })

  // <base href> makes relative URLs resolve off-proxy — neutralize it
  rewriter.on('base', {
    element(el) {
      el.remove()
    },
  })

  const injectAdShieldPrep =
    !disableJs &&
    !botChallenge &&
    bypassAdblockDetection &&
    shouldInjectAdShieldPrep(baseUrl, html)
  const injectTinyShield =
    !disableJs &&
    !botChallenge &&
    bypassAdblockDetection &&
    shouldInjectTinyShield(baseUrl, html)

  rewriter.on('head', {
    element(el) {
      el.append(
        '<style data-bf-chrome>body { margin-top: 48px !important; } [data-bf-topbar]{ z-index:2147483647 !important; }</style>',
        { html: true }
      )
      // Always inject reveal — WSJ soft walls use mask fades on normal 200 pages.
      // Cleanup ads can stay off during pure captcha interstitials.
      if (!botChallenge) {
        el.append(`<style data-bf-cleanup>${CLEANUP_CSS}</style>`, { html: true })
      }
      el.append(`<style data-bf-reveal>${CONTENT_REVEAL_CSS}</style>`, { html: true })


      if (cosmetics.styles) {
        el.append(`<style data-bf-cosmetics id="bf-cosmetics-live">${cosmetics.styles}</style>`, {
          html: true,
        })
      }

      // Navigation guard first (even when NoScript is off). With NoScript we still
      // need server-side form merge + catch-all; guard requires JS.
      if (!disableJs) {
        const scriptParts: string[] = [
          buildNavigationGuardScript(safeBaseUrl),
          buildCookieSyncScript(safeBaseUrl),
          buildFetchAndXhrProxyScript(safeBaseUrl),
        ]

        // Canvas spoofing breaks DataDome WASM / sensor — skip on challenges
        if (!botChallenge) {
          scriptParts.push(FINGERPRINT_SPOOF_SCRIPT)
        }

        // Always clear soft-paywall fades (mask-image), even on DD hosts
        scriptParts.push(CONTENT_REVEAL_SCRIPT)

        if (bypassAdblockDetection && !botChallenge) {
          if (injectAdShieldPrep || injectTinyShield) {
            scriptParts.push(FUTURE_ADSHIELD_PREP_SCRIPT)
          }
          scriptParts.push(ANTI_ADBLOCK_STUB_SCRIPT)
          for (const s of cosmetics.scripts) {
            scriptParts.push(s)
          }
        }

        if (cosmetics.styles) {
          scriptParts.push(buildCosmeticObserverScript(cosmetics.styles))
        }

        // tinyShield only as fallback when config flip failed (or FORCE_TINYSHIELD)
        if (injectTinyShield) {
          el.prepend(
            '<script data-bf-tinyshield src="/bf/tinyshield.js"></script>',
            { html: true }
          )
        }
        el.prepend(`<script data-bf-inject>${scriptParts.join('\n')}</script>`, { html: true })
      }
    },
  })

  if (disableJs) {
    rewriter.on('script', {
      element(el) {
        // Keep our chrome scripts if any slipped in; remove page scripts
        if (
          el.getAttribute('data-bf-inject') ||
          el.getAttribute('data-bf-topbar-fallback') ||
          el.getAttribute('data-bf-tinyshield')
        ) {
          return
        }
        el.remove()
      },
    })
  }

  rewriter.on('a', {
    element(el) {
      const href = el.getAttribute('href')
      if (el.hasAttribute('data-native-proxy-link')) {
        return
      }

      if (href) {
        const absolute = resolveUrl(baseUrl, href)
        if (absolute.startsWith('http') && !absolute.includes('/browse?url=')) {
          el.setAttribute('href', `/browse?url=${encodeURIComponent(absolute)}`)
        } else {
          el.setAttribute('href', absolute)
        }
      }
    },
  })

  rewriter.on('form', {
    element(el) {
      if (el.hasAttribute('data-native-proxy-form')) {
        return
      }

      const method = (el.getAttribute('method') || 'get').toLowerCase()
      const action = el.getAttribute('action')
      const absolute = action
        ? resolveUrl(baseUrl, action)
        : baseUrl

      if (absolute.startsWith('http') && !absolute.includes('/browse?url=')) {
        // GET forms: browser will append fields as &q=... alongside url= — server merges them.
        // POST forms: same action; browse POST forwards the body.
        el.setAttribute('action', `/browse?url=${encodeURIComponent(absolute)}`)
        if (method === 'post') {
          el.setAttribute('method', 'post')
        }
      } else if (!action) {
        el.setAttribute('action', `/browse?url=${encodeURIComponent(baseUrl)}`)
      }
    },
  })

  function isBotChallengeHost(url: string): boolean {
    try {
      const h = new URL(url).hostname.toLowerCase()
      return /(^|\.)(datadome\.co|captcha-delivery\.com)$/.test(h)
    } catch {
      return false
    }
  }

  rewriter.on('img, iframe, source, track, link', {
    element(el) {
      const tag = el.tagName.toLowerCase()
      if (tag === 'link' && bypassAdblockDetection && !botChallenge) {
        const rel = (el.getAttribute('rel') || '').toLowerCase()
        if (
          (rel.includes('modulepreload') || rel.includes('preload') || rel.includes('prefetch')) &&
          isAdShieldLoaderUrl(el.getAttribute('href'))
        ) {
          el.remove()
          return
        }
      }

      const srcAttr = el.hasAttribute('src') ? 'src' : 'href'
      const src = el.getAttribute(srcAttr)
      if (src) {
        const absolute = resolveUrl(baseUrl, src)
        // Load DataDome/captcha iframes & assets directly in the real browser
        if (absolute.startsWith('http') && isBotChallengeHost(absolute)) {
          el.setAttribute(srcAttr, absolute)
          return
        }
        if (absolute.startsWith('http') && !absolute.includes('/asset?url=')) {
          el.setAttribute(srcAttr, `/asset?url=${encodeURIComponent(absolute)}`)
        } else {
          el.setAttribute(srcAttr, absolute)
        }
      }

      const srcset = el.getAttribute('srcset')
      if (srcset) {
        el.removeAttribute('srcset')
      }
    },
  })

  if (!disableJs) {
    rewriter.on('script', {
      element(el) {
        if (
          el.getAttribute('data-bf-inject') ||
          el.getAttribute('data-bf-topbar-fallback') ||
          el.getAttribute('data-bf-tinyshield')
        ) {
          return
        }
        const src = el.getAttribute('src')
        // Strip Ad-Shield / Future ad loaders so detection never runs
        if (!botChallenge && bypassAdblockDetection && isAdShieldLoaderUrl(src)) {
          el.remove()
          return
        }
        if (src) {
          // Never proxy our first-party /bf/* helpers through /asset
          if (src.startsWith('/bf/')) return
          const absolute = resolveUrl(baseUrl, src)
          if (absolute.startsWith('http') && isBotChallengeHost(absolute)) {
            el.setAttribute('src', absolute)
            return
          }
          if (absolute.startsWith('http') && !absolute.includes('/asset?url=')) {
            el.setAttribute('src', `/asset?url=${encodeURIComponent(absolute)}`)
          } else {
            el.setAttribute('src', absolute)
          }
        }
      },
    })
  }

  // Mark top bar for fallback detection — patch attribute onto injected HTML
  // (TopBar root gets data-bf-topbar via string replace)
  const marked = html // already have topBar with attribute from TopBar component update

  return rewriter.transform(
    new Response(marked, {
      status: source.status,
      statusText: source.statusText,
      headers: source.headers,
    })
  )
}

/**
 * Merge sibling query params from /browse?url=TARGET&q=... into TARGET.
 * Fixes Google/search forms that submit q= next to url= on the proxy host.
 */
export function mergeBrowseQueryIntoTarget(requestUrl: string, targetUrl: string): string {
  try {
    const incoming = new URL(requestUrl)
    const target = new URL(targetUrl)
    for (const [key, value] of incoming.searchParams.entries()) {
      if (key === 'url') continue
      target.searchParams.append(key, value)
    }
    return target.href
  } catch {
    return targetUrl
  }
}
