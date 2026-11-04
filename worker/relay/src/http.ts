// Gemeinsame Antwort-Bausteine: Sicherheits-Header, JSON, HTML, begrenztes Lesen.
// Bewusst ohne CORS-Header: Die API spricht nur der Main-Prozess der App an (kein
// Browser), und die Besucher-Seiten braucht keine fremde Webseite mitzulesen.

/** CSP der Worker-eigenen Seiten: kein Skript, keine fremden Ressourcen, kein Einbetten. */
export const WORKER_PAGE_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; " +
  "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** Ziel der Rohdaten-Weiterleitungen: die Quick Tunnels der Geräte. */
export const TUNNEL_SOURCE = 'https://*.trycloudflare.com'

/**
 * CSP für durchgereichte Freigabe-Seiten. Kompatibel mit den App-Seiten (Inline-
 * Styles, Schriften vom selben Ursprung, Daten-Bilder aus der Word-Vorschau). Bild,
 * Video/Audio und PDF-iframe zeigen auf `/<T>/d` und landen per 302 beim Tunnel –
 * die CSP prüft auch das Ziel einer Weiterleitung, deshalb steht der Tunnel-Ursprung
 * mit drin. Strenger als die App: `default-src 'none'`, kein `blob:`,
 * `object-src 'none'`, kein Einbetten der Seite selbst.
 */
export const PROXY_PAGE_CSP =
  `default-src 'none'; img-src 'self' data: ${TUNNEL_SOURCE}; media-src 'self' ${TUNNEL_SOURCE}; ` +
  `style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'self' ${TUNNEL_SOURCE}; ` +
  "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/**
 * CSP für alles Durchgereichte, das keine HTML-Seite ist (Schriften, „Seiten“ mit
 * anderem Typ): eigener Sandkasten ohne Skripte; Speichern bleibt möglich.
 */
export const RAW_CSP =
  "sandbox allow-downloads; default-src 'none'; img-src 'self' data:; media-src 'self'; " +
  "style-src 'unsafe-inline'; frame-ancestors 'self'"

/**
 * PDF ohne Sandbox: Der PDF-Betrachter der Browser läuft in einer Sandbox nicht
 * (die Vorschau im iframe bliebe leer). Einbetten nur durch eigene Seiten.
 */
export const PDF_CSP = "frame-ancestors 'self'"

/** Header, die jede Antwort des Workers trägt – egal, was ein Tunnel schickt. */
export function baseSecurityHeaders(h: Headers): Headers {
  h.set('X-Content-Type-Options', 'nosniff')
  h.set('Referrer-Policy', 'no-referrer')
  h.set('X-Robots-Tag', 'noindex, nofollow')
  h.set('Cross-Origin-Resource-Policy', 'same-origin')
  h.set('Strict-Transport-Security', 'max-age=31536000')
  return h
}

export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  const h = baseSecurityHeaders(new Headers(extra))
  h.set('Content-Type', 'application/json; charset=utf-8')
  h.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(body), { status, headers: h })
}

export function apiError(error: string, status: number, extra?: Record<string, string>): Response {
  return json({ ok: false, error }, status, extra)
}

/** 302 mit festen Sicherheits-Headern und ohne Cache. */
export function redirect(location: string): Response {
  const h = baseSecurityHeaders(new Headers())
  h.set('Location', location)
  h.set('Cache-Control', 'no-store')
  return new Response(null, { status: 302, headers: h })
}

/** Worker-eigene HTML-Seite. Bei HEAD ohne Körper, Header gleich. */
export function html(
  request: Request,
  body: string,
  status = 200,
  extra?: Record<string, string>
): Response {
  const h = baseSecurityHeaders(new Headers(extra))
  h.set('Content-Type', 'text/html; charset=utf-8')
  h.set('Content-Security-Policy', WORKER_PAGE_CSP)
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store')
  const bytes = new TextEncoder().encode(body)
  h.set('Content-Length', String(bytes.byteLength))
  return new Response(request.method === 'HEAD' ? null : bytes, { status, headers: h })
}

export function plain(request: Request, body: string, status = 200, extra?: Record<string, string>): Response {
  const h = baseSecurityHeaders(new Headers(extra))
  h.set('Content-Type', 'text/plain; charset=utf-8')
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store')
  return new Response(request.method === 'HEAD' ? null : body, { status, headers: h })
}

export class BodyTooLarge extends Error {}

/**
 * Anfrage-Körper als Text lesen, höchstens `max` Bytes. Ein falsches oder fehlendes
 * Content-Length wird nicht geglaubt: Der Strom wird mitgezählt und abgebrochen.
 */
export async function readLimited(request: Request, max: number): Promise<string> {
  const declared = request.headers.get('Content-Length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > max) throw new BodyTooLarge()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new BodyTooLarge()
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all)
}
