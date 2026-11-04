// Durchreichen eines Besucher-Aufrufs an den Tunnel eines Geräts – gestreamt, ohne
// Puffern. Der Worker verlässt sich dabei auf nichts, was der Tunnel schickt:
// Jemand könnte statt Foldwing einen eigenen Server hinter seinen Tunnel hängen.
// Deshalb gehen nur erlaubte Header in beide Richtungen, Status-Codes werden
// gefiltert und die Sicherheits-Header setzt immer der Worker selbst.

import type { FetchLike, HtmlElement, HtmlRewriterLike } from './env'
import type { RelayPath } from './ids'
import { PDF_CSP, PROXY_PAGE_CSP, RAW_CSP, baseSecurityHeaders } from './http'

/** Anfrage-Header, die zum Tunnel dürfen – mit Längen- bzw. Formatgrenze. */
const REQUEST_HEADERS: Array<[string, RegExp]> = [
  ['Range', /^bytes=\d*-\d*(?:\s*,\s*\d*-\d*){0,9}$/],
  ['If-Range', /^[\x21-\x7e][\x20-\x7e]{0,199}$/],
  ['If-None-Match', /^[\x21-\x7e][\x20-\x7e]{0,499}$/],
  ['If-Modified-Since', /^[A-Za-z0-9 ,:]{1,64}$/],
  ['Accept', /^[\x20-\x7e]{1,1000}$/],
  ['Accept-Language', /^[A-Za-z0-9 ,;=.*_-]{1,200}$/]
]

/** Antwort-Header, die vom Tunnel übernommen werden – jeweils mit Formatprüfung. */
const RESPONSE_HEADERS: Array<[string, RegExp]> = [
  ['Content-Length', /^\d{1,16}$/],
  ['Content-Range', /^bytes (?:\d{1,16}-\d{1,16}|\*)\/(?:\d{1,16}|\*)$/],
  ['Accept-Ranges', /^(?:bytes|none)$/],
  ['ETag', /^(?:W\/)?"[\x21\x23-\x7e]{0,200}"$/],
  ['Last-Modified', /^[A-Za-z0-9 ,:]{1,64}$/]
]

/** Wie lange der Tunnel Zeit hat, mit den Antwort-Headern anzufangen. */
export const ORIGIN_TIMEOUT_MS = 45_000

export function forwardRequestHeaders(request: Request): Headers {
  const out = new Headers()
  for (const [name, format] of REQUEST_HEADERS) {
    const v = request.headers.get(name)
    if (v !== null && format.test(v)) out.set(name, v)
  }
  // Ein fester User-Agent statt dem des Besuchers. Keine Cookies, keine IP, kein
  // Referer – nichts davon steht in der Allowlist.
  out.set('User-Agent', 'Foldwing-Relay')
  return out
}

/**
 * Tunnel abfragen. `origin` ist bereits als Quick-Tunnel-Adresse geprüft, `path`
 * als Relay-Pfad. Ergebnis null = nicht erreichbar (Netzfehler, Zeitüberschreitung).
 */
export async function fetchOrigin(
  fetchFn: FetchLike,
  origin: string,
  rp: RelayPath,
  request: Request,
  search: string,
  timeoutMs = ORIGIN_TIMEOUT_MS
): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchFn(origin + rp.path + search, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: forwardRequestHeaders(request),
      // Weiterleitungen nie folgen: Sonst könnte ein Tunnel den Worker auf ein
      // beliebiges Ziel lenken (SSRF). Ein 3xx wird unten zu 502.
      redirect: 'manual',
      signal: controller.signal,
      // Dateien landen nie im Cloudflare-Cache.
      cache: 'no-store'
    })
  } catch {
    return null
  } finally {
    // Nur die Wartezeit auf die Header ist begrenzt; der Körper läuft danach frei,
    // damit große Downloads nicht mittendrin abbrechen.
    clearTimeout(timer)
  }
}

/** Ergebnis der Prüfung einer Tunnel-Antwort. */
export type OriginVerdict = { ok: Response } | { offline: true } | { bad: true }

/** Status-Codes, die unverändert an Besucher gehen dürfen. */
const PASS_STATUS = new Set([200, 204, 206, 304, 400, 403, 404, 410, 412, 416, 429])
/** Tunnel bzw. App nicht erreichbar (cloudflared: 502, Quick Tunnel weg: 530). */
const OFFLINE_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])

/** Medientyp bereinigen: nur Typ/Subtyp plus ein sauberes charset. */
export function normalizeType(raw: string | null): { essence: string; header: string } {
  const fallback = { essence: 'application/octet-stream', header: 'application/octet-stream' }
  if (!raw || raw.length > 200) return fallback
  const [first, ...params] = raw.split(';')
  const essence = first.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/.test(essence)) return fallback
  let charset: string | null = null
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([A-Za-z0-9._-]{1,40})"?\s*$/i.exec(p)
    if (m) charset = m[1].toLowerCase()
  }
  return { essence, header: charset ? `${essence}; charset=${charset}` : essence }
}

const SAFE_IMAGES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/tiff',
  'image/heic',
  'image/heif'
])

/**
 * Darf ein Typ direkt im Browser angezeigt werden? Bilder außer SVG, Video, Audio,
 * PDF und reiner Text. Alles andere (HTML, SVG, XML, unbekannt) wird Download.
 */
export function isSafeInline(essence: string): boolean {
  if (SAFE_IMAGES.has(essence)) return true
  if (/^(?:video|audio)\/[a-z0-9.-]+$/.test(essence)) return true
  return essence === 'application/pdf' || essence === 'text/plain'
}

/**
 * Den Dateinamen aus einer Content-Disposition übernehmen – nur in der Form
 * `filename*=UTF-8''<prozent-kodiert>`, wie die App sie schickt. Alles andere fällt
 * weg; der Browser nimmt dann den Pfad als Namen.
 */
export function filenameParam(cd: string | null): string {
  if (!cd || cd.length > 4096) return ''
  const m = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^\s;]{1,3000})\s*(?:;|$)/i.exec(cd)
  if (!m || !/^[A-Za-z0-9!#$&+.^_`|~%'()*-]+$/.test(m[1])) return ''
  return `; filename*=UTF-8''${m[1]}`
}

/**
 * Antwort des Tunnels für den Besucher aufbereiten. Der Körper wird nie gelesen,
 * nur als Strom weitergegeben (Range, große Dateien, konstanter Speicher).
 */
export function shapeResponse(request: Request, rp: RelayPath, upstream: Response): OriginVerdict {
  const status = upstream.status
  if (OFFLINE_STATUS.has(status)) return { offline: true }
  if (!PASS_STATUS.has(status)) return { bad: true }

  const h = baseSecurityHeaders(new Headers())
  for (const [name, format] of RESPONSE_HEADERS) {
    const v = upstream.headers.get(name)
    if (v !== null && format.test(v)) h.set(name, v)
  }
  const type = normalizeType(upstream.headers.get('Content-Type'))
  const failed = status >= 400
  let isHtmlPage = false

  if (rp.kind === 'font' && status === 200) {
    h.set('Content-Type', 'font/woff2')
    h.set('Content-Security-Policy', RAW_CSP)
    h.set('Cache-Control', 'private, max-age=3600')
  } else if (rp.kind === 'page' && (type.essence === 'text/html' || status === 304)) {
    isHtmlPage = status !== 304
    h.set('Content-Type', status === 304 ? type.header : `text/html; charset=${charsetOf(type.header)}`)
    h.set('Content-Security-Policy', PROXY_PAGE_CSP)
    h.set('Cache-Control', 'private, no-store')
  } else {
    // Rohdaten – oder eine „Seite“, die keine ist: dieselben harten Regeln.
    h.set('Content-Type', type.header)
    h.set('Content-Security-Policy', type.essence === 'application/pdf' ? PDF_CSP : RAW_CSP)
    h.set('Cache-Control', failed || rp.kind === 'page' ? 'private, no-store' : 'private, max-age=3600')
    const cd = upstream.headers.get('Content-Disposition')
    const name = filenameParam(cd)
    if (!isSafeInline(type.essence)) {
      h.set('Content-Disposition', `attachment${name}`)
    } else if (cd) {
      h.set('Content-Disposition', `${/^\s*attachment/i.test(cd) ? 'attachment' : 'inline'}${name}`)
    }
  }
  if (failed) h.set('Cache-Control', 'no-store')

  const noBody = request.method === 'HEAD' || status === 204 || status === 304
  if (noBody) {
    try {
      upstream.body?.cancel().catch(() => undefined)
    } catch {
      /* Strom schon zu */
    }
    return { ok: new Response(null, { status, headers: h }) }
  }
  const res = new Response(upstream.body, { status, headers: h })
  return { ok: isHtmlPage ? stripActiveMarkup(res) : res }
}

function charsetOf(header: string): string {
  const m = /charset=([A-Za-z0-9._-]+)/.exec(header)
  return m ? m[1] : 'utf-8'
}

/**
 * Was die CSP nicht abdeckt, aus fremdem HTML entfernen: `<meta http-equiv>`
 * (vor allem `refresh` – sonst wäre der Relay eine offene Weiterleitung für
 * Phishing), `<link>` (Prefetch, DNS-Prefetch) und `<base>`. Die App-Seiten nutzen
 * nichts davon. Läuft gestreamt mit dem HTMLRewriter der Workers-Laufzeit.
 */
export function stripActiveMarkup(res: Response): Response {
  const Rewriter = (globalThis as { HTMLRewriter?: new () => HtmlRewriterLike }).HTMLRewriter
  if (!Rewriter) return res
  // Die Länge stimmt nach dem Umbau nicht mehr; die Laufzeit überträgt dann in Stücken.
  const out = new Response(res.body, res)
  out.headers.delete('Content-Length')
  return new Rewriter()
    .on('meta', {
      element(el: HtmlElement) {
        if (el.getAttribute('http-equiv') !== null) el.remove()
      }
    })
    .on('link', { element: (el: HtmlElement) => el.remove() })
    .on('base', { element: (el: HtmlElement) => el.remove() })
    .transform(out)
}
