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

  // Always apply cosmetic ad-hiding; anti-adblock stubs/scriptlets are optional
  const cosmetics = getCosmeticsForUrl(baseUrl)

  // Buffer HTML so we can run Ghostery HTML filters (script-tag removal etc.)
  const source = htmlStream instanceof Response ? htmlStream : new Response(htmlStream)
  let html = await source.text()
  html = applyHtmlFilters(baseUrl, html)

  const rewriter = new HTMLRewriter()

  rewriter.on('body', {
    element(el) {
      el.prepend(topBarHtml, { html: true })
      el.prepend('<div style="height: 48px; width: 100%;"></div>', { html: true })
    },
  })

  rewriter.on('head', {
    element(el) {
      el.append('<style>body { margin-top: 48px !important; }</style>', { html: true })
      el.append(`<style data-bf-cleanup>${CLEANUP_CSS}</style>`, { html: true })

      if (cosmetics.styles) {
        el.append(`<style data-bf-cosmetics id="bf-cosmetics-live">${cosmetics.styles}</style>`, {
          html: true,
        })
      }

      if (!disableJs) {
        const scriptParts: string[] = [FINGERPRINT_SPOOF_SCRIPT]

        if (bypassAdblockDetection) {
          scriptParts.push(ANTI_ADBLOCK_STUB_SCRIPT)
          for (const s of cosmetics.scripts) {
            scriptParts.push(s)
          }
        }

        // Keep cosmetic CSS alive as SPAs inject new DOM
        if (cosmetics.styles) {
          scriptParts.push(buildCosmeticObserverScript(cosmetics.styles))
        }

        scriptParts.push(`
          (function() {
            const originalFetch = window.fetch;
            const base = '${safeBaseUrl}';
            window.fetch = function() {
              if (typeof arguments[0] === 'string' && arguments[0].startsWith('/')) {
                arguments[0] = '/asset?url=' + encodeURIComponent(new URL(arguments[0], base).href);
              }
              return originalFetch.apply(this, arguments);
            };
          })();
        `)

        el.prepend(`<script data-bf-inject>${scriptParts.join('\n')}</script>`, { html: true })
      }
    },
  })

  if (disableJs) {
    rewriter.on('script', {
      element(el) {
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

      const action = el.getAttribute('action')
      if (action) {
        const absolute = resolveUrl(baseUrl, action)
        if (absolute.startsWith('http') && !absolute.includes('/browse?url=')) {
          el.setAttribute('action', `/browse?url=${encodeURIComponent(absolute)}`)
        }
      } else {
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
          // Drop known ad iframes/images at rewrite time when we can
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
        const src = el.getAttribute('src')
        if (src) {
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

  return rewriter.transform(
    new Response(html, {
      status: source.status,
      statusText: source.statusText,
      headers: source.headers,
    })
  )
}
