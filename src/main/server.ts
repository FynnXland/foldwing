import { createServer, Server, IncomingMessage, ServerResponse } from 'http'
import { createReadStream, promises as fsp } from 'fs'
import { join } from 'path'
import type { ShareStore, ShareMeta, ShareFile } from './store'
import { isExpired, isBundle, bundleFile } from './store'
import { sharePage, bundlePage, landingPage, GONE_TEXT, EXPIRED_TEXT } from './pages'
import { buildPreview } from './preview'
import { createZipStream, zipSize, type ZipEntry } from './zip-write'
import { routeSharePath, type ShareLinks } from './links'

export interface ServerHandle {
  server: Server
  port: number
  close: () => Promise<void>
}

export interface ServerHooks {
  /**
   * Eigene Geräte-ID für die Relay-Pfade (`/<T>…`) und /api/health – oder null,
   * solange es keine gibt. Als Funktion, weil sie sich ändern kann (409 beim Relay).
   */
  deviceId?: () => string | null
}

// ---- Vorschau-Zwischenspeicher ---------------------------------------------
// buildPreview ist teuer und teils SYNCHRON (xlsx liest die Datei blockierend).
// Ohne Zwischenspeicher konnte jeder, der einen Link kennt, den Main-Prozess mit
// wiederholten /s/-Aufrufen einfrieren. Deshalb: Ergebnis je Freigabe merken
// (LRU, gedeckelt) und immer nur EINE Berechnung gleichzeitig laufen lassen.
const PREVIEW_CACHE_MAX = 50
// Zusätzlich eine Speicher-Obergrenze: eine Text-Vorschau darf ein paar Megabyte
// groß werden, 50 davon wären sonst hunderte Megabyte im Arbeitsspeicher.
const PREVIEW_CACHE_MAX_BYTES = 32 * 1024 * 1024
const previewCache = new Map<string, string>()
const previewInFlight = new Map<string, Promise<string>>()
let previewBytes = 0
// Serialisiert die Berechnungen: die nächste startet erst, wenn die vorige durch ist.
let previewQueue: Promise<void> = Promise.resolve()

/** Ältesten Eintrag verwerfen, bis Anzahl und Größe wieder im Rahmen sind. */
function trimPreviewCache(keep: string): void {
  while (previewCache.size > PREVIEW_CACHE_MAX || previewBytes > PREVIEW_CACHE_MAX_BYTES) {
    const oldest = previewCache.keys().next().value
    // Den gerade erzeugten Eintrag nie wegwerfen (er ist für die laufende Antwort).
    if (oldest === undefined || oldest === keep) break
    previewBytes -= previewCache.get(oldest)?.length ?? 0
    previewCache.delete(oldest)
  }
}

/**
 * Vorschau aus dem Zwischenspeicher – oder genau einmal berechnen.
 *
 * `key` ist `"<familie>|<id>"` bzw. `"<familie>|<id>/<fid>"`. Die Teildatei-Trennung
 * verhindert, dass die zweite Datei einer Sammlung die Vorschau der ersten bekommt;
 * die Pfadfamilie (lan bzw. relay:<T>), dass eine über den Relay abgerufene Seite
 * Datei-URLs der LAN-Familie enthält (und umgekehrt).
 */
async function cachedPreview(
  key: string,
  meta: ShareMeta,
  binPath: string,
  fileUrl: string
): Promise<string> {
  const hit = previewCache.get(key)
  if (hit !== undefined) {
    previewCache.delete(key) // zuletzt benutzt -> ans Ende (LRU)
    previewCache.set(key, hit)
    return hit
  }
  const running = previewInFlight.get(key)
  if (running) return running // parallele Anfragen warten auf dieselbe Promise

  const work = previewQueue.then(() => buildPreview(meta, binPath, fileUrl))
  // Die Warteschlange darf an einem Fehler nicht hängen bleiben.
  previewQueue = work.then(
    () => undefined,
    () => undefined
  )
  previewInFlight.set(key, work)
  try {
    const html = await work
    previewCache.set(key, html)
    previewBytes += html.length
    trimPreviewCache(key)
    return html
  } finally {
    previewInFlight.delete(key)
  }
}

/** Schlüssel im Vorschau-Cache. */
function previewKey(links: ShareLinks, id: string, fid?: string): string {
  return `${links.cacheKey}|${fid ? `${id}/${fid}` : id}`
}

/**
 * Einträge einer Freigabe vergessen (gelöscht oder abgelaufen) – in allen
 * Pfadfamilien und inklusive aller Teildateien `"<id>/<fid>"` einer Sammlung.
 */
function forgetPreview(id: string): void {
  const prefix = `${id}/`
  for (const key of [...previewCache.keys()]) {
    const rest = key.slice(key.indexOf('|') + 1)
    if (rest !== id && !rest.startsWith(prefix)) continue
    previewBytes -= previewCache.get(key)?.length ?? 0
    previewCache.delete(key)
  }
}

/**
 * Den ganzen Vorschau-Zwischenspeicher verwerfen – z. B. wenn der Server ruht, weil
 * nichts mehr geteilt ist. Sonst blieben bis zu PREVIEW_CACHE_MAX_BYTES im Speicher.
 */
export function clearPreviewCache(): void {
  previewCache.clear()
  previewBytes = 0
}

/**
 * Eingebetteter HTTP-Server. Liefert die Freigabe-Seiten und die Dateien selbst
 * aus – inklusive HTTP-Range-Unterstützung, damit Videos im Browser direkt und
 * verlustfrei abgespielt und durchgespult werden können.
 *
 * Alle Ressourcen der Freigabe-Seite werden als absolute Pfade der anfragenden
 * Pfadfamilie referenziert (links.ts): `/f/<id>` im eigenen Netz und auf der
 * eigenen Domain, `/<T>/d` über den Relay.
 *
 * `host` begrenzt, wo der Server lauscht: im Relay-Modus nur 127.0.0.1 (dort
 * holt cloudflared ab), sonst alle Schnittstellen (LAN-Links).
 */
export function startServer(
  store: ShareStore,
  desiredPort: number,
  hooks: ServerHooks,
  host?: string
): Promise<ServerHandle> {
  const server = createServer((req, res) => handle(req, res, store, hooks))

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(desiredPort, host, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : desiredPort
      resolve({
        server,
        port,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: ShareStore,
  hooks: ServerHooks
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = decodeURIComponent(url.pathname)
    const ownDevice = hooks.deviceId?.() ?? null

    if (path === '/' || path === '') return sendHtml(res, 200, landingPage())
    if (path === '/api/health') {
      return sendJson(res, 200, { ok: true, app: 'Foldwing', device: ownDevice })
    }

    // Freigabe- und Schriften-Pfade beider Familien; Relay-Pfade nur fürs eigene Gerät.
    const route = routeSharePath(path, ownDevice)
    if (!route || route.kind === 'foreign') return sendPlain(res, 404, 'Nicht gefunden')

    // Selbst gehostete Geist-Schriften (kein CDN – Datenhoheit).
    if (route.kind === 'font') {
      const base =
        (process as { resourcesPath?: string }).resourcesPath ?? join(process.cwd(), 'resources')
      const fp = join(base, 'fonts', `${route.font}.woff2`)
      try {
        const buf = await fsp.readFile(fp)
        res.writeHead(200, {
          'Content-Type': 'font/woff2',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff'
        })
        res.end(buf)
        return
      } catch {
        return sendPlain(res, 404, 'Nicht gefunden')
      }
    }

    const { links, shareId, fid: wantedFid } = route

    // Freigabe-Seite: Sammlung oder Einzeldatei, bzw. eine Datei aus einer Sammlung.
    if (route.kind === 'page') {
      const meta = await store.get(shareId)
      if (!meta) {
        forgetPreview(shareId)
        return sendHtml(res, 404, landingPage(GONE_TEXT, links), links.family)
      }
      if (isExpired(meta)) {
        forgetPreview(meta.id)
        return sendHtml(res, 404, landingPage(EXPIRED_TEXT, links), links.family)
      }

      if (wantedFid) {
        // Nur Sammlungen haben Teildateien; die fid muss in den Metadaten stehen.
        const file = bundleFile(meta, wantedFid)
        if (!file) {
          return sendHtml(res, 404, landingPage(GONE_TEXT, links), links.family)
        }
        const preview = await cachedPreview(
          previewKey(links, meta.id, file.fid),
          partMeta(meta, file),
          store.binPath(meta.id, file.fid),
          links.raw(file.fid)
        )
        return sendHtml(res, 200, sharePage(meta, preview, links, { file }), links.family)
      }

      if (isBundle(meta)) return sendHtml(res, 200, bundlePage(meta, links), links.family)
      const preview = await cachedPreview(
        previewKey(links, meta.id),
        meta,
        store.binPath(meta.id),
        links.raw()
      )
      return sendHtml(res, 200, sharePage(meta, preview, links), links.family)
    }

    // Rohdaten: Einzeldatei bzw. ZIP der ganzen Sammlung, oder eine Datei daraus.
    const meta = await store.get(shareId)
    if (!meta || isExpired(meta)) {
      forgetPreview(shareId)
      return sendPlain(res, 404, 'Nicht gefunden')
    }
    const download = url.searchParams.get('dl') === '1'
    if (wantedFid) {
      const file = bundleFile(meta, wantedFid)
      if (!file) return sendPlain(res, 404, 'Nicht gefunden')
      return serveFile(req, res, store.binPath(meta.id, file.fid), file, download)
    }
    if (isBundle(meta)) return serveBundleZip(req, res, store, meta)
    return serveFile(req, res, store.binPath(meta.id), meta, download)
  } catch {
    if (!res.headersSent) sendPlain(res, 500, 'Serverfehler')
    else res.end()
  }
}

/**
 * Vorschau-Metadaten einer Teildatei: Name/MIME/Größe kommen aus der Datei,
 * alles andere (id, createdAt, Ablauf) aus der Freigabe. `files` fällt weg,
 * damit niemand das Ding versehentlich für eine Sammlung hält.
 */
function partMeta(meta: ShareMeta, file: ShareFile): ShareMeta {
  const { files: _bundle, ...rest } = meta
  return { ...rest, name: file.name, mime: file.mime, size: file.size }
}

/**
 * Datei mit Range-Unterstützung ausliefern (Streaming, konstanter Speicher).
 * Bekommt bewusst nur Pfad + Name/MIME – damit gilt exakt dasselbe Verhalten
 * für eine Einzeldatei wie für eine Teildatei einer Sammlung.
 */
async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  binPath: string,
  meta: { name: string; mime: string },
  download: boolean
): Promise<void> {
  let size: number
  try {
    size = (await fsp.stat(binPath)).size
  } catch {
    return sendPlain(res, 404, 'Datei fehlt')
  }

  // HTML/SVG/XML dürfen NIE inline laufen: Sie würden im Browser als Seite auf
  // unserer Domain ausgeführt (gespeichertes XSS). Erzwungener Download statt
  // Anzeige; <img>-Vorschauen funktionieren trotzdem (Disposition wirkt nur bei
  // direkter Navigation).
  const dangerousInline = /^(text\/html|image\/svg|application\/xhtml|text\/xml|application\/xml)/i.test(
    meta.mime
  )
  const attach = download || dangerousInline
  const disposition = attach
    ? `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`
    : `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`

  const baseHeaders: Record<string, string> = {
    'Content-Type': meta.mime,
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    // Browser darf den Typ nicht "erraten" (verhindert HTML-Sniffing in z. B. .txt).
    'X-Content-Type-Options': 'nosniff'
  }

  // Zweite Verteidigungslinie hinter der Attachment-Regel oben: Sollte je ein Typ
  // durchrutschen, den der Browser doch als Dokument darstellt, läuft er in einem
  // Sandkasten – keine Skripte, keine Formulare, keine Plugins, eigene Herkunft.
  // `allow-downloads` bleibt drin, damit „Speichern unter" aus der Direktansicht
  // weiter funktioniert (Verlustfreiheit geht vor Härte, die Skriptsperre bleibt).
  // AUSNAHME PDF: der PDF-Betrachter von Chrome ist ein Plugin und wird von der
  // Sandbox erschlagen – die Vorschau (<iframe src="/f/..">) bliebe leer. PDFs sind
  // ohnehin kein Weg zu XSS auf unserer Herkunft, sie laufen im eigenen Betrachter.
  if (!/^application\/pdf\b/i.test(meta.mime)) {
    baseHeaders['Content-Security-Policy'] = 'sandbox allow-downloads'
  }

  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0
      let end = m[2] ? parseInt(m[2], 10) : size - 1
      if (isNaN(start)) start = 0
      if (isNaN(end) || end >= size) end = size - 1
      if (start > end || start >= size) {
        res.writeHead(416, {
          'Content-Range': `bytes */${size}`,
          'X-Content-Type-Options': 'nosniff'
        })
        res.end()
        return
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1)
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(binPath, { start, end }).pipe(res)
      return
    }
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(binPath).pipe(res)
}

/**
 * Ganze Sammlung als ZIP ausliefern (stored, also verlustfrei und ohne
 * Kompression). Weil die Archivgröße vorab exakt bekannt ist, geht das mit
 * echtem `Content-Length` – der Browser zeigt einen Fortschritt.
 *
 * Range wird bewusst NICHT bedient: Der Inhalt entsteht erst beim Streamen,
 * ein Teilbereich ließe sich nicht ohne Neuberechnung liefern. Ein
 * `Range`-Header wird daher ignoriert (`Accept-Ranges: none`) statt in einer
 * falschen 206 zu enden.
 */
async function serveBundleZip(
  req: IncomingMessage,
  res: ServerResponse,
  store: ShareStore,
  meta: ShareMeta
): Promise<void> {
  const entries: ZipEntry[] = []
  for (const f of meta.files ?? []) {
    const path = store.binPath(meta.id, f.fid)
    try {
      // ECHTE Größe von der Platte: Die Metadaten könnten veraltet sein, und
      // eine falsche Größe würde die vorberechnete Content-Length zerlegen.
      const st = await fsp.stat(path)
      if (!st.isFile()) return sendPlain(res, 404, 'Datei fehlt')
      entries.push({ name: f.name, path, size: st.size, mtime: st.mtime })
    } catch {
      return sendPlain(res, 404, 'Datei fehlt')
    }
  }

  let total: number
  try {
    total = zipSize(entries)
  } catch {
    return sendPlain(res, 500, 'Archiv konnte nicht erzeugt werden')
  }

  const zipName = `foldwing-${meta.id.replace(/[^A-Za-z0-9]/g, '')}.zip`
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': String(total),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    // Wir können hier keinen Teilbereich bedienen – ehrlich so ansagen.
    'Accept-Ranges': 'none',
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox allow-downloads'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const stream = createZipStream(entries)
  // Verschwindet eine Datei mitten im Stream, ist die angekündigte Länge nicht
  // mehr einzuhalten: Verbindung hart abbrechen statt ein abgeschnittenes,
  // scheinbar vollständiges Archiv auszuliefern.
  stream.on('error', () => {
    stream.destroy()
    res.destroy()
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(s)
}

/**
 * Über den Relay abgerufene Seiten betten Rohdaten ein, die der Relay per 302 an
 * den Quick Tunnel weiterleitet – CSP prüft auch das Ziel einer Weiterleitung.
 * (Der Relay setzt für seine Seiten eine eigene CSP; diese hier gilt beim direkten
 * Abruf über den Tunnel und hält beides deckungsgleich.)
 */
const TUNNEL_SRC = 'https://*.trycloudflare.com'

function sendHtml(res: ServerResponse, code: number, html: string, family: 'lan' | 'relay' = 'lan'): void {
  const extra = family === 'relay' ? ` ${TUNNEL_SRC}` : ''
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    // Kein aktiver Code auf der Seite; erlaubt nur eigene Ressourcen, Inline-Styles
    // und Daten-Bilder (aus der Word-Konvertierung). Schützt den Betrachter.
    'Content-Security-Policy':
      `default-src 'self'; img-src 'self' data: blob:${extra}; media-src 'self' blob:${extra}; ` +
      `style-src 'self' 'unsafe-inline'; frame-src 'self'${extra}; object-src 'self'${extra}; ` +
      "script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  })
  res.end(html)
}

function sendPlain(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(text)
}
