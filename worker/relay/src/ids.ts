// Kennungen und Pfade des Relays. Alles wird gegen feste Formate geprüft, bevor es
// in eine Datenbank-Abfrage, eine URL oder eine Seite wandert.

/** Geräte-ID D: genau 8 Zeichen base62. */
export const DEVICE_ID = /^[A-Za-z0-9]{8}$/
/** Lange Link-ID T = D + S (8 + 10 Zeichen base62). */
export const TOKEN = /^[A-Za-z0-9]{18}$/
/** Secret der App: 32 Zufallsbytes als base64url ohne Auffüllung = 43 Zeichen. */
export const SECRET = /^[A-Za-z0-9_-]{43}$/
/** App-Version, nur grob begrenzt (wird nicht gespeichert). */
export const VERSION = /^[0-9A-Za-z.+-]{1,32}$/

/**
 * Quick-Tunnel-Adresse. Strenger als `^https://[a-z0-9-]+\.trycloudflare\.com$`:
 * ein einziges DNS-Label mit höchstens 63 Zeichen, ohne Bindestrich am Rand. Kein
 * Port, kein Pfad, keine Zugangsdaten – damit gibt es keinen Weg, den Worker als
 * offenen Proxy auf andere Ziele zu richten.
 */
export const TUNNEL_URL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/

export function isTunnelUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && TUNNEL_URL.test(value)
}

/** Art eines Relay-Pfads: Seite, Rohdaten oder Schrift. */
export type RelayKind = 'page' | 'raw' | 'font'

export interface RelayPath {
  kind: RelayKind
  /** T (18 Zeichen) */
  token: string
  /** D (die ersten 8 Zeichen von T) */
  device: string
  /** der Pfad, so wie er an den Tunnel geht (bereits geprüft) */
  path: string
}

// /<T>, /<T>/<F>, /<T>/d, /<T>/<F>/d – F hat genau 6 Zeichen, „d“ eines.
const RELAY_PATH = /^\/([A-Za-z0-9]{18})(?:\/([A-Za-z0-9]{6}))?(\/d)?$/
// Nur genau diese zwei Schrift-Dateien.
const FONT_PATH = /^\/([A-Za-z0-9]{18})\/_font\/(?:Geist-Variable|GeistMono-Variable)\.woff2$/

/**
 * Relay-Pfad erkennen. Der rohe (nicht dekodierte) Pfad wird geprüft – Prozent-
 * Kodierung, Punkte oder doppelte Schrägstriche passen damit nie.
 */
export function parseRelayPath(pathname: string): RelayPath | null {
  const font = FONT_PATH.exec(pathname)
  if (font) return { kind: 'font', token: font[1], device: font[1].slice(0, 8), path: pathname }
  const m = RELAY_PATH.exec(pathname)
  if (!m) return null
  return { kind: m[3] ? 'raw' : 'page', token: m[1], device: m[1].slice(0, 8), path: pathname }
}

/**
 * T aus einer Eingabe für das Melden holen: entweder T selbst oder ein Relay-Link
 * bzw. Relay-Pfad, dessen erster Abschnitt T ist. Alles andere ergibt null.
 */
export function tokenFromInput(input: string | null): string | null {
  if (!input) return null
  const s = input.trim()
  if (s.length > 300) return null
  if (TOKEN.test(s)) return s
  let path = s
  if (/^https?:\/\//i.test(s)) {
    try {
      path = new URL(s).pathname
    } catch {
      return null
    }
  }
  const m = /^\/([A-Za-z0-9]{18})(?:\/|$)/.exec(path)
  return m ? m[1] : null
}
