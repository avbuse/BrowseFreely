import { LRUCache } from 'lru-cache'

interface CacheEntry {
  buffer: ArrayBuffer
  contentType: string
}

// 50MB max cache size for assets — keyed by sessionStorageKey + url to avoid cross-user leaks
export const assetCache = new LRUCache<string, CacheEntry>({
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: (value) => value.buffer.byteLength,
  ttl: 1000 * 60 * 60, // 1 hour
})

export function cacheKey(sessionStorageKey: string, url: string): string {
  return `${sessionStorageKey}::${url}`
}

const PUBLIC_TYPES = /^(image\/|font\/|text\/css|application\/font|application\/javascript|text\/javascript)/i

export function isLikelyPublicAsset(contentType: string, url: string): boolean {
  if (PUBLIC_TYPES.test(contentType)) return true
  return /\.(css|js|mjs|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico|avif)(\?|$)/i.test(url)
}
