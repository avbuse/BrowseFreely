/**
 * Soft-paywall / snippet-fade defeat + optional archive fallback for WSJ.
 */

export function hostnameIsDowJonesNews(pageUrl: string): boolean {
  try {
    const h = new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase()
    return (
      h === 'wsj.com' ||
      h.endsWith('.wsj.com') ||
      h === 'barrons.com' ||
      h.endsWith('.barrons.com') ||
      h === 'marketwatch.com' ||
      h.endsWith('.marketwatch.com')
    )
  } catch {
    return false
  }
}

export function looksLikeSoftPaywallHtml(html: string): boolean {
  if (/Please enable JS and disable any ad blocker/i.test(html)) return false
  const hasSnippetCue =
    /wsj-snippet|snippet-body|snippet-overlay|cx-snippet|paywall-overlay|isAccessibleForFree"\s*:\s*false/i.test(
      html
    ) || /class="[^"]*paywall[^"]*"/i.test(html) || /class='[^']*paywall[^']*'/i.test(html)

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')

  // Teaser pages are usually short on readable prose even when the HTML shell is large
  if (hasSnippetCue && text.length < 20000) return true
  if (text.length < 3500) return true
  return false
}

export function looksLikeArticlePath(pageUrl: string): boolean {
  try {
    const path = new URL(pageUrl).pathname
    return (
      /\/(business|finance|articles|markets|opinion|tech|politics|world|lifestyle|economy)\//i.test(
        path
      ) || /-[0-9a-f]{6,}$/i.test(path)
    )
  } catch {
    return false
  }
}

/**
 * Try archive.is / archive.ph for a fuller snapshot (calibre WSJ recipe approach).
 * Returns HTML or null.
 */
export async function fetchArchiveSnapshot(pageUrl: string): Promise<string | null> {
  if (process.env.DISABLE_ARCHIVE_FALLBACK === 'true') return null

  const mirrors = [
    `https://archive.is/newest/${pageUrl}`,
    `https://archive.ph/newest/${pageUrl}`,
    `https://archive.today/newest/${pageUrl}`,
  ]

  for (const mirror of mirrors) {
    try {
      const res = await fetch(mirror, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        // @ts-expect-error bun tls
        tls: { rejectUnauthorized: true },
      } as RequestInit)

      if (!res.ok) continue
      const html = await res.text()
      if (html.length < 5000) continue
      if (/captcha|Just a moment|cf-browser-verification/i.test(html) && html.length < 20000) {
        continue
      }
      // archive search/landing pages are smallish templates; real snapshots are large
      if (/id="CONTENT"|id='CONTENT'|<!-- End Wayback|ARCHIVE\.is|archive\.ph/i.test(html)) {
        // Prefer embedded original content length
        const spaceHits = (html.match(/SpaceX|articleBody|data-type="paragraph"/gi) || []).length
        if (spaceHits >= 1 || html.length > 80000) {
          console.log(`[archive] Using snapshot from ${mirror} (${html.length} bytes)`)
          return html
        }
      }
      // Some mirrors redirect straight into a snapshot document
      if (html.length > 80000 && /<article|itemprop="articleBody"|data-type="paragraph"/i.test(html)) {
        console.log(`[archive] Using large snapshot from ${mirror} (${html.length} bytes)`)
        return html
      }
    } catch (e: any) {
      console.warn('[archive] fetch failed:', mirror, e?.message || e)
    }
  }
  return null
}
