/**
 * tinyShield — community userscript that defeats Ad-Shield's anti-adblock
 * integrity layer (used by Future plc sites like windowscentral.com).
 *
 * Source: https://github.com/FilteringDev/tinyShield (MPL-2.0)
 */

const TINYSHIELD_URL =
  process.env.TINYSHIELD_URL ||
  'https://cdn.jsdelivr.net/npm/@filteringdev/tinyshield@latest/dist/tinyShield.user.js'

/** Future plc + known Ad-Shield hosts where tinyShield is required */
export const ADSHIELD_HOSTS = new Set([
  'windowscentral.com',
  'androidcentral.com',
  'tomshardware.com',
  'tomsguide.com',
  'techradar.com',
  'pcgamer.com',
  'gamesradar.com',
  'livescience.com',
  'space.com',
  't3.com',
  'whathifi.com',
  'creativebloq.com',
  'digitalcameraworld.com',
  'guitarworld.com',
  'musicradar.com',
  'loudersound.com',
  'cyclingnews.com',
  'cyclingweekly.com',
  'fourfourtwo.com',
  'golfmonthly.com',
  'homesandgardens.com',
  'idealhome.co.uk',
  'livingetc.com',
  'marieclaire.com',
  'marieclaire.co.uk',
  'wallpaper.com',
  'womanandhome.com',
  'itpro.com',
  'techlearning.com',
  'kiplinger.com',
  'moneyweek.com',
  'theweek.com',
  'shortlist.com',
  'whatculture.com',
  'whowhatwear.com',
  'fitandwell.com',
  'gardeningknowhow.com',
  'petsradar.com',
  'tvtechnology.com',
  'avnetwork.com',
  'cinemablend.com',
  'countrylife.co.uk',
  'homebuilding.co.uk',
  'myvouchercodes.co.uk',
  'advnture.com',
])

let cachedScript: string | null = null
let loading: Promise<string> | null = null
let lastError: string | null = null

function stripUserscriptHeader(source: string): string {
  return source.replace(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/m, '')
}

export async function getTinyShieldScript(): Promise<string> {
  if (cachedScript) return cachedScript
  if (loading) return loading

  loading = (async () => {
    console.log('[TINYSHIELD] Downloading Ad-Shield bypass userscript...')
    try {
      const res = await fetch(TINYSHIELD_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const raw = await res.text()
      if (raw.length < 1000 || !raw.includes('tinyShield')) {
        throw new Error('Unexpected tinyShield payload')
      }
      // Page context: map unsafeWindow → window (Tampermonkey grant)
      const body = stripUserscriptHeader(raw)
      cachedScript =
        '/* BrowseFreely-hosted tinyShield (MPL-2.0) */\n' +
        'var unsafeWindow = window;\n' +
        body
      lastError = null
      console.log(`[TINYSHIELD] Ready (${Math.round(cachedScript.length / 1024)} KB)`)
      return cachedScript
    } catch (e: any) {
      lastError = e?.message || String(e)
      console.error('[TINYSHIELD] Failed to load:', lastError)
      // Minimal no-op so /bf/tinyshield.js still 200s
      cachedScript =
        'console.warn("[BrowseFreely] tinyShield unavailable:", ' +
        JSON.stringify(lastError) +
        ');'
      return cachedScript
    }
  })()

  return loading
}

export function tinyShieldStatus(): { ready: boolean; error: string | null; bytes: number } {
  return {
    ready: Boolean(cachedScript && cachedScript.includes('tinyShield')),
    error: lastError,
    bytes: cachedScript?.length || 0,
  }
}

export function hostnameMatchesAdShield(pageUrl: string): boolean {
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase()
    if (ADSHIELD_HOSTS.has(host)) return true
    // Subdomains of known hosts
    for (const h of ADSHIELD_HOSTS) {
      if (host.endsWith('.' + h)) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

export function htmlEnablesAdShield(html: string): boolean {
  return /"adShield"\s*:\s*\{\s*"enabled"\s*:\s*true/i.test(html)
}

/**
 * Flip Future plc `"adShield":{"enabled":true}` so the page never arms detection.
 * Prefer this over fighting the detector — if the flag is off, Ads/Ad-Shield stay idle.
 */
export function neutralizeAdShieldConfig(html: string): string {
  return html.replace(
    /"adShield"\s*:\s*\{\s*"enabled"\s*:\s*true(\s*\})/gi,
    '"adShield":{"enabled":false$1'
  )
}

/** Resolve proxied `/asset?url=` back to the upstream URL for matching. */
function upstreamFromSrc(src: string): string {
  try {
    if (src.includes('/asset?url=')) {
      const q = src.split('/asset?url=')[1]?.split(/[&"']/)[0]
      if (q) return decodeURIComponent(q)
    }
  } catch {
    /* ignore */
  }
  return src
}

/**
 * Future / Ad-Shield loader scripts — remove from the rewritten document so
 * detection never executes (network blocking alone can still trip integrity checks).
 */
export function isAdShieldLoaderUrl(src: string | null | undefined): boolean {
  if (!src) return false
  const u = upstreamFromSrc(src).toLowerCase()
  return (
    /\/vite\/assets\/ads\/ads\.ts/i.test(u) ||
    /\/ads\/ads\.ts-/i.test(u) ||
    /bordeaux\.futurecdn\.net/i.test(u) ||
    /freyr\.futurecdn\.net/i.test(u) ||
    /vanir\.futurecdn\.net/i.test(u) ||
    /ad-?shield\.(io|de|info|club)/i.test(u) ||
    /cdn\.jsdelivr\.net\/(?:npm\/)?protected-reward-ad/i.test(u) ||
    /cdn\.jsdelivr\.net\/gh\/ad-shield/i.test(u) ||
    /refitted\.net/i.test(u) ||
    /(?:html|css|content)-load\.com/i.test(u) ||
    /feload\.com/i.test(u) ||
    /22pixx\.xyz/i.test(u)
  )
}

export function shouldInjectAdShieldPrep(pageUrl: string, html: string): boolean {
  return hostnameMatchesAdShield(pageUrl) || htmlEnablesAdShield(html) || /"adShield"\s*:/i.test(html)
}

/**
 * tinyShield is a fallback only: after we strip loaders + disable the config flag,
 * most Future pages don't need it. Force with FORCE_TINYSHIELD=true; skip with DISABLE_TINYSHIELD.
 */
export function shouldInjectTinyShield(pageUrl: string, html: string): boolean {
  if (process.env.DISABLE_TINYSHIELD === 'true') return false
  if (process.env.FORCE_TINYSHIELD === 'true') {
    return hostnameMatchesAdShield(pageUrl) || htmlEnablesAdShield(html) || /"adShield"\s*:/i.test(html)
  }
  // Fallback when config flip didn't take (obfuscated / unexpected shape)
  return htmlEnablesAdShield(html)
}

/**
 * Runs before tinyShield / page scripts on Future plc sites.
 * Sets article-view cookie the lists expect and stubs Bordeaux ad cmd queue.
 */
export const FUTURE_ADSHIELD_PREP_SCRIPT = `
(function() {
  try {
    document.cookie = 'FTR_Article_PageView=2; path=/; max-age=86400; SameSite=Lax';
    document.cookie = 'FTR_Article_PageView_Count=2; path=/; max-age=86400; SameSite=Lax';

    // Bordeaux ad stack — keep cmd queue safe if scripts are stubbed/blocked
    window.bordeaux = window.bordeaux || { cmd: [] };
    if (!Array.isArray(window.bordeaux.cmd)) window.bordeaux.cmd = [];
    var origPush = Array.prototype.push;
    // Ensure pushes don't throw if controller never loads
    window.bordeaux.cmd.push = function() {
      try { return origPush.apply(this, arguments); } catch (e) { return this.length; }
    };

    // Hide Future / Ad-Shield "please allow ads" chrome as it appears.
    // Do NOT hide Sourcepoint/OneTrust consent UI — users need it to save prefs.
    var css = document.createElement('style');
    css.setAttribute('data-bf-adshield', '1');
    css.textContent = [
      '.swal-modal,.swal-overlay,.swal2-container,.swal2-backdrop-show,',
      '[class*="adblock-wall" i],[class*="adblock_wall" i],[class*="adblock-modal" i],',
      '[id*="adblock-detected" i],[id*="adblock-notification" i],',
      '[class*="allow-ads" i],[class*="allowAds" i],',
      '[class*="disable-adblock" i],[class*="adb-enabled" i],',
      '[data-testid*="adblock" i],.van-ads,.van_ads,',
      '#ad-blocker-notice,.ad-blocker-notice,.adblocker-message,',
      '.fc-ab-root',
      '{display:none!important;visibility:hidden!important;pointer-events:none!important;',
      'height:0!important;max-height:0!important;opacity:0!important;}'
    ].join('');
    (document.documentElement || document.head).appendChild(css);

    var kill = function() {
      try {
        document.querySelectorAll(
          '.swal-modal,.swal-overlay,.swal2-container,[class*="adblock-wall" i],[class*="adblock_wall" i],[class*="adblock-modal" i],[id*="adblock-detected" i],#ad-blocker-notice,.ad-blocker-notice,.fc-ab-root'
        ).forEach(function(n){ n.remove(); });
        if (document.body) {
          document.body.style.removeProperty('overflow');
          document.documentElement.style.removeProperty('overflow');
        }
      } catch (e) {}
    };
    setInterval(kill, 1000);
    try {
      new MutationObserver(kill).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  } catch (e) {}
})();
`
