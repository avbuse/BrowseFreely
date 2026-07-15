import { Context } from 'hono'
import { getCookie } from 'hono/cookie'

export interface UserSettings {
  userAgent: string
  disableJs: boolean
  bypassAdblockDetection: boolean
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

export function getSettings(c: Context): UserSettings {
  const settingsCookie = getCookie(c, 'bf_settings')
  try {
    if (settingsCookie) {
      // Hono getCookie already URL-decodes. Older builds double-encoded with
      // encodeURIComponent, so accept both raw JSON and one extra decode.
      let raw = settingsCookie
      if (raw.startsWith('%') || raw.includes('%7B') || raw.includes('%7b')) {
        try {
          raw = decodeURIComponent(raw)
        } catch {
          /* keep raw */
        }
      }
      const parsed = JSON.parse(raw)
      return {
        userAgent: parsed.userAgent || DEFAULT_USER_AGENT,
        disableJs: !!parsed.disableJs,
        // Default ON when unset so existing cookies still get anti-adblock help
        bypassAdblockDetection:
          parsed.bypassAdblockDetection === undefined
            ? true
            : !!parsed.bypassAdblockDetection,
      }
    }
  } catch {
    // Ignore parse error
  }
  return {
    userAgent: DEFAULT_USER_AGENT,
    disableJs: false,
    bypassAdblockDetection: true,
  }
}
