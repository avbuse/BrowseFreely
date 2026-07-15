import { resolveUrl } from './url'
import { TopBar } from '../components/TopBar'
import { FINGERPRINT_SPOOF_SCRIPT } from './fingerprint'
import {
  ANTI_ADBLOCK_STUB_SCRIPT,
  CLEANUP_CSS,
  applyHtmlFilters,
  buildCosmeticObserverScript,
  getCosmeticsForUrl,
} from './adblocker'
import { buildNavigationGuardScript } from './navigationGuard'
import {
  FUTURE_ADSHIELD_PREP_SCRIPT,
  shouldInjectTinyShield,
} from './tinyshield'

function escapeForJsString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/<\//g, '<\\/')
}

export async function rewriteHtml(
  htmlStream: ReadableStream | Response,
  baseUrl: string,
  disableJs: boolean,
  bypassAdblockDetection: boolean = true
): Promise<Response> {
  const topBarHtml = TopBar({ currentUrl: baseUrl, disableJs }).toString()
  const safeBaseUrl = escapeForJsString(baseUrl)

  const cosmetics = getCosmeticsForUrl(baseUrl)

  const source = htmlStream instanceof Response ? htmlStream : new Response(htmlStream)
  let html = await source.text()
  html = applyHtmlFilters(baseUrl, html)

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

  const injectTinyShield =
    !disableJs && bypassAdblockDetection && shouldInjectTinyShield(baseUrl, html)

  rewriter.on('head', {
    element(el) {
      el.append(
        '<style data-bf-chrome>body { margin-top: 48px !important; } [data-bf-topbar]{ z-index:2147483647 !important; }</style>',
        { html: true }
      )
      el.append(`<style data-bf-cleanup>${CLEANUP_CSS}</style>`, { html: true })

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
          FINGERPRINT_SPOOF_SCRIPT,
        ]

        if (bypassAdblockDetection) {
          if (injectTinyShield) {
            // Must run before page Ad-Shield scripts; tinyShield follows as external src.
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

        scriptParts.push(`
          (function() {
            const originalFetch = window.fetch;
            const base = '${safeBaseUrl}';
            window.fetch = function() {
              var input = arguments[0];
              if (typeof input === 'string' && input.startsWith('/') &&
                  input.indexOf('/browse') !== 0 && input.indexOf('/asset') !== 0 &&
                  input.indexOf('/api/') !== 0 && input.indexOf('/bf/') !== 0) {
                arguments[0] = '/asset?url=' + encodeURIComponent(new URL(input, base).href);
              } else if (input && typeof input === 'object' && typeof input.url === 'string') {
                try {
                  var u = input.url;
                  if (u.startsWith('/') && u.indexOf('/browse') !== 0 && u.indexOf('/asset') !== 0 &&
                      u.indexOf('/bf/') !== 0) {
                    arguments[0] = new Request('/asset?url=' + encodeURIComponent(new URL(u, base).href), input);
                  }
                } catch (e) {}
              }
              return originalFetch.apply(this, arguments);
            };
          })();
        `)

        // Prepend so BF + tinyShield run before site scripts in <head>
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

  rewriter.on('img, iframe, source, track, link', {
    element(el) {
      const srcAttr = el.hasAttribute('src') ? 'src' : 'href'
      const src = el.getAttribute(srcAttr)
      if (src) {
        const absolute = resolveUrl(baseUrl, src)
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
        if (src) {
          // Never proxy our first-party /bf/* helpers through /asset
          if (src.startsWith('/bf/')) return
          const absolute = resolveUrl(baseUrl, src)
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
