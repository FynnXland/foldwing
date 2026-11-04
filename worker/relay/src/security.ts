import type { RateLimiter } from './env'

/** SHA-256 als Kleinbuchstaben-Hex. */
export async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  let out = ''
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Zeitkonstanter Vergleich. Verglichen werden immer zwei SHA-256-Hashes (gleich
 * lang), die Laufzeit hängt dann nicht davon ab, ab welchem Zeichen sie abweichen.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/**
 * Schlüssel für die Ratenbegrenzung je Netz. Die IP-Adresse wird nur gehasht und
 * gekürzt an den flüchtigen Zähler von Cloudflare gegeben, nie gespeichert und nie
 * an einen Tunnel weitergereicht.
 */
export async function networkKey(request: Request): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip) return 'none'
  return (await sha256hex('foldwing-relay:' + ip)).slice(0, 24)
}

/**
 * true, wenn die Anfrage über dem Limit liegt. Ohne Binding oder bei einem Fehler
 * des Bindings läuft alles weiter (fail-open): Die Begrenzung ist ein Schutz vor
 * Missbrauch, keine Bedingung für den Betrieb.
 */
export async function overLimit(limiter: RateLimiter | undefined, keys: string[]): Promise<boolean> {
  if (!limiter) return false
  try {
    for (const key of keys) {
      const { success } = await limiter.limit({ key })
      if (!success) return true
    }
  } catch {
    return false
  }
  return false
}
