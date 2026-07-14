/**
 * AES-256-GCM helpers for encrypting the in-memory session cookie jar.
 * Key material comes from SESSION_SECRET (or a process-local ephemeral secret).
 */

let cachedKey: CryptoKey | null = null
let warnedMissingSecret = false

function getSecretBytes(): Uint8Array {
  const fromEnv = process.env.SESSION_SECRET
  if (fromEnv && fromEnv.length >= 16) {
    return new TextEncoder().encode(fromEnv)
  }

  if (!warnedMissingSecret) {
    warnedMissingSecret = true
    console.warn(
      '[SESSION] SESSION_SECRET not set (or too short). Using an ephemeral key — ' +
        'encrypted jars will not survive process restarts. Set SESSION_SECRET in .env.'
    )
  }

  // Stable for this process only
  if (!(globalThis as any).__bfEphemeralSecret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    ;(globalThis as any).__bfEphemeralSecret = bytes
  }
  return (globalThis as any).__bfEphemeralSecret as Uint8Array
}

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey

  const digest = await crypto.subtle.digest('SHA-256', getSecretBytes())
  cachedKey = await crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )
  return cachedKey
}

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function b64ToBuf(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export type EncryptedBlob = {
  iv: string
  ct: string
}

export async function encryptText(plaintext: string): Promise<EncryptedBlob> {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  return { iv: bufToB64(iv), ct: bufToB64(ciphertext) }
}

export async function decryptText(blob: EncryptedBlob): Promise<string | null> {
  try {
    const key = await getKey()
    const iv = b64ToBuf(blob.iv)
    const ct = b64ToBuf(blob.ct)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

export async function storageKeyFor(sessionId: string, clientIp: string): Promise<string> {
  const material = new TextEncoder().encode(`${sessionId}|${clientIp}`)
  const digest = await crypto.subtle.digest('SHA-256', material)
  return bufToB64(digest)
}
