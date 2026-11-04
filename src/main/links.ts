/**
 * Pfadfamilien der Freigabe-Seiten – rein, ohne Electron (getestet in tests/links.test.ts).
 *
 * Dieselbe Freigabe ist unter zwei Pfadfamilien erreichbar:
 *   - LAN/Domain:  /s/<S>, /s/<S>/<F>, /f/<S>, /f/<S>/<F>, /_font/…
 *   - Relay:       /<T>, /<T>/<F>, /<T>/d, /<T>/<F>/d, /<T>/_font/…   (T = Geräte-ID + S)
 * Der Relay reicht seine Pfade unverändert an den Tunnel weiter. Eine Seite, die
 * über einen Relay-Pfad abgerufen wird, darf intern nur Relay-Pfade verlinken –
 * sonst zeigten Bilder, Downloads und Schriften beim Empfänger ins Leere.
 */
import { DEVICE_ID_RE, FILE_ID_RE, TOKEN_RE } from './relay'

export interface ShareLinks {
  family: 'lan' | 'relay'
  /** Schlüssel-Präfix für den Vorschau-Cache: gleiche Familie, gleiche URLs. */
  cacheKey: string
  /** Seite der Freigabe bzw. einer Datei der Sammlung. */
  page(fid?: string): string
  /** Rohdaten (Einzeldatei, ZIP der Sammlung bzw. eine Datei daraus). */
  raw(fid?: string): string
  /** Basis der Schriften, ohne Schrägstrich am Ende. */
  fontBase: string
  /** Nur Relay: die lange ID T für den Melden-Link. */
  token?: string
}

/** Nur base62 – auch eine manipulierte Metadatei kann so kein Attribut aufbrechen. */
function safe(code: string): string {
  return String(code ?? '').replace(/[^A-Za-z0-9]/g, '')
}

export function lanLinks(shareId: string): ShareLinks {
  const s = safe(shareId)
  return {
    family: 'lan',
    cacheKey: 'lan',
    page: (fid) => (fid ? `/s/${s}/${safe(fid)}` : `/s/${s}`),
    raw: (fid) => (fid ? `/f/${s}/${safe(fid)}` : `/f/${s}`),
    fontBase: '/_font'
  }
}

export function relayLinks(deviceId: string, shareId: string): ShareLinks {
  const t = safe(deviceId) + safe(shareId)
  return {
    family: 'relay',
    cacheKey: `relay:${t}`,
    page: (fid) => (fid ? `/${t}/${safe(fid)}` : `/${t}`),
    raw: (fid) => (fid ? `/${t}/${safe(fid)}/d` : `/${t}/d`),
    fontBase: `/${t}/_font`,
    token: t
  }
}

/**
 * Eingabe für die eigene Domain zu einer sauberen Basis-URL machen: Schema
 * ergänzen (https), Schrägstriche am Ende weg. Nur http/https ohne Zugangsdaten,
 * Query oder Fragment; null, wenn es keine brauchbare Adresse ist. Leer bleibt leer.
 */
export function normalizeBaseUrl(input: string): string | null {
  const v = String(input ?? '').trim()
  if (!v) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password || u.search || u.hash || !u.hostname.includes('.')) return null
    return (u.origin + u.pathname).replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** Ergebnis der Pfad-Auswertung auf dem App-Server. */
export type RoutedPath =
  | { kind: 'page'; links: ShareLinks; shareId: string; fid?: string }
  | { kind: 'raw'; links: ShareLinks; shareId: string; fid?: string }
  | { kind: 'font'; font: 'Geist-Variable' | 'GeistMono-Variable' }
  /** Relay-Pfad für ein fremdes Gerät (oder ohne eigene Geräte-ID) -> 404. */
  | { kind: 'foreign' }
  | null

const FONT_RE = /^(Geist-Variable|GeistMono-Variable)\.woff2$/

/**
 * Freigabe-Pfad (bereits URL-dekodiert) auswerten. `ownDeviceId` ist die eigene
 * Geräte-ID oder null, solange es keine gibt. Liefert null für alles, was kein
 * Freigabe-/Schriften-Pfad ist.
 */
export function routeSharePath(path: string, ownDeviceId: string | null): RoutedPath {
  const parts = path.split('/')
  if (parts[0] !== '') return null
  const seg = parts.slice(1)

  // ---- LAN/Domain-Familie --------------------------------------------------
  if (seg[0] === '_font' && seg.length === 2) {
    const m = FONT_RE.exec(seg[1])
    return m ? { kind: 'font', font: m[1] as 'Geist-Variable' | 'GeistMono-Variable' } : null
  }
  if ((seg[0] === 's' || seg[0] === 'f') && (seg.length === 2 || seg.length === 3)) {
    const [, id, fid] = seg
    if (!/^[A-Za-z0-9]+$/.test(id)) return null
    if (fid !== undefined && !/^[A-Za-z0-9]+$/.test(fid)) return null
    return { kind: seg[0] === 's' ? 'page' : 'raw', links: lanLinks(id), shareId: id, fid }
  }

  // ---- Relay-Familie ---------------------------------------------------------
  if (!TOKEN_RE.test(seg[0] ?? '')) return null
  const token = seg[0]
  const deviceId = token.slice(0, 8)
  const shareId = token.slice(8)
  const rest = seg.slice(1)

  let routed: RoutedPath = null
  if (rest.length === 0) routed = { kind: 'page', links: relayLinks(deviceId, shareId), shareId }
  else if (rest.length === 1 && rest[0] === 'd')
    routed = { kind: 'raw', links: relayLinks(deviceId, shareId), shareId }
  else if (rest.length === 1 && FILE_ID_RE.test(rest[0]))
    routed = { kind: 'page', links: relayLinks(deviceId, shareId), shareId, fid: rest[0] }
  else if (rest.length === 2 && FILE_ID_RE.test(rest[0]) && rest[1] === 'd')
    routed = { kind: 'raw', links: relayLinks(deviceId, shareId), shareId, fid: rest[0] }
  else if (rest.length === 2 && rest[0] === '_font') {
    const m = FONT_RE.exec(rest[1])
    if (m) routed = { kind: 'font', font: m[1] as 'Geist-Variable' | 'GeistMono-Variable' }
  }
  if (!routed) return null
  // Nur das eigene Gerät: Fremde T bekommen nichts, auch keine Schriften.
  if (!ownDeviceId || !DEVICE_ID_RE.test(ownDeviceId) || deviceId !== ownDeviceId) return { kind: 'foreign' }
  return routed
}
