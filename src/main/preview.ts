import { promises as fsp } from 'fs'
import type { ShareMeta } from './store'
import { listZipEntries, ZipEntry } from './zip'

/*
 * xlsx (~18–25 MB) und mammoth (~9–13 MB im Hauptprozess, je nach Messung) braucht
 * nur die Excel- bzw. Word-Vorschau – sie werden deshalb erst beim ersten Gebrauch
 * geladen (einmalig ~0,1–0,2 s) statt beim Start, und bleiben danach im Modul-Cache.
 * Beide sind CommonJS: Unter ESM liegt die API auf `default` (CLAUDE.md §6);
 * `?? mod` deckt eine Umgebung ohne ab.
 */
type XlsxApi = typeof import('xlsx')
type MammothApi = typeof import('mammoth')
let xlsxLoading: Promise<XlsxApi> | null = null
let mammothLoading: Promise<MammothApi> | null = null

function cjsApi<T>(mod: T): T {
  return (mod as { default?: T }).default ?? mod
}

function loadXlsx(): Promise<XlsxApi> {
  xlsxLoading ??= import('xlsx').then(cjsApi, (e) => {
    xlsxLoading = null // Fehlschlag nicht festschreiben – die nächste Vorschau versucht es neu
    throw e
  })
  return xlsxLoading
}

function loadMammoth(): Promise<MammothApi> {
  mammothLoading ??= import('mammoth').then(cjsApi, (e) => {
    mammothLoading = null
    throw e
  })
  return mammothLoading
}

/**
 * Erzeugt die HTML-Vorschau für die Freigabe-Seite – ausschließlich zum ANSEHEN.
 * Der Download bleibt immer die bit-identische Originaldatei; hier wird nichts an
 * der Datei verändert. Alle Konvertierungen laufen lokal im Server (keine externen
 * Viewer-Dienste), damit die Datenhoheit gewahrt bleibt.
 */

// Konvertierungen laden die Datei (teilweise) in den Speicher – daher Limits,
// damit die App bei riesigen Dateien nicht einfriert. Medien/PDF streamt der
// Browser selbst und haben deshalb kein Limit.
const DOC_LIMIT = 30 * 1024 * 1024
const SHEET_LIMIT = 20 * 1024 * 1024
const TEXT_LIMIT = 3 * 1024 * 1024
// Deckel für fertig gesäubertes Bibliotheks-HTML (Tabelle/Dokument): eine
// Riesentabelle darf die Freigabe-Seite nicht sprengen – gleiches Muster wie
// TEXT_LIMIT, nur eben auf dem erzeugten HTML statt auf der Rohdatei.
const HTML_LIMIT = 2 * 1024 * 1024

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'env',
  'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'less', 'html', 'htm', 'svg',
  'py', 'java', 'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh',
  'bat', 'ps1', 'sql', 'toml', 'gradle', 'kt', 'swift', 'r'
])

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ------------------------------------------------------------------ */
/* Sanitisierung von Bibliotheks-HTML                                   */
/* ------------------------------------------------------------------ */

/*
 * xlsx (`sheet_to_html`) und mammoth erzeugen HTML aus fremdem Dateiinhalt und
 * geben dabei nachweislich Angreifer-Text roh weiter: `sheet_to_html` schreibt
 * den Zellwert UNESCAPED in `data-v="…"`, eine Zelle wie
 *   a"><meta http-equiv="refresh" content="0;url=…"><b x="
 * bricht also aus dem Attribut aus; Zell-Hyperlinks landen als
 * `<a href="javascript:…">` in der Seite. Die CSP der Freigabe-Seite hat zwar
 * `script-src 'none'`, blockt aber weder `<meta refresh>` (stiller Redirect auf
 * eine Phishing-Seite unter unserer vertrauten Adresse) noch `<style>`,
 * `<iframe>` oder `<img>`. Deshalb geht kein Bibliotheks-HTML ungeprüft raus.
 *
 * Der Ansatz ist bewusst eine Allowlist über einen echten Tokenizer (kein
 * Regex-Filter – die sind bekanntermaßen umgehbar): erlaubte Tags bleiben,
 * ALLE Attribute fallen weg (auch href/src/style/id/class/data-*), alles andere
 * wird verworfen. Was ohne Attribute nicht mehr funktioniert (Links, Bilder),
 * fehlt in der Vorschau – der Download hat es vollständig.
 */

/** Tags, deren Inhalt roher Text ist – Tag UND Inhalt fliegen komplett raus. */
const RAW_TEXT_TAGS = new Set([
  'script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noscript', 'noframes', 'template'
])

/** Tags ohne Ende-Tag: dafür wird nie ein `</…>` ausgegeben. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
])

/** Tabellen-Vorschau (xlsx/csv): nur das Gerüst, kein `data-v`, kein `<a>`. */
export const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])

/**
 * Word-Vorschau (mammoth): Fließtext-Auszeichnung.
 * Kein `a` (Zieladresse käme aus der Datei), kein `img` – mammoth bettet Bilder
 * sonst als data-URI ein, und ein selbst deklarierter Content-Type aus einer
 * fremden Datei ist genau die Sniffing-Fläche, die wir nicht wollen.
 */
export const DOC_TAGS = new Set([
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i', 'u', 's', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'blockquote', 'pre', 'code', 'sup', 'sub'
])

const NAME_START = /[a-zA-Z]/
const NAME_CHAR = /[a-zA-Z0-9:_-]/

/** Liest den Tag-Namen ab `i` (erste Stelle nach `<` bzw. `</`). */
function readName(html: string, i: number): string {
  let j = i
  while (j < html.length && NAME_CHAR.test(html[j])) j++
  return html.slice(i, j).toLowerCase()
}

/**
 * Findet das `>`, das den Tag ab `from` schließt – Anführungszeichen in
 * Attributwerten werden übersprungen, damit `id="a>b"` den Tag nicht vorzeitig
 * beendet. Rückgabe: Index des `>` oder `-1`, wenn der Tag unvollständig ist.
 */
function findTagEnd(html: string, from: number): number {
  let quote = ''
  for (let j = from; j < html.length; j++) {
    const ch = html[j]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return j
    }
  }
  return -1
}

/**
 * Entfernt aus Bibliotheks-HTML alles außer den erlaubten Tags – und aus diesen
 * sämtliche Attribute. Textknoten bleiben erhalten (xlsx und mammoth escapen
 * Textinhalt bereits korrekt; ein übrig gebliebenes `>` wird trotzdem escaped,
 * `<` erledigt schon der Tokenizer). Rein und ohne Seiteneffekte, damit testbar.
 */
export function sanitizePreviewHtml(html: string, allowedTags: Set<string>): string {
  const out: string[] = []
  const plain: string[] = [] // Nur-Text-Variante für den Notfall-Fallback
  const len = html.length
  let i = 0

  const pushText = (t: string): void => {
    if (!t) return
    plain.push(t)
    out.push(t.replace(/>/g, '&gt;'))
  }

  while (i < len) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      pushText(html.slice(i))
      break
    }
    pushText(html.slice(i, lt))

    const next = html[lt + 1]

    // Kommentare und Deklarationen (`<!-- -->`, `<!DOCTYPE>`, `<?…>`) verwerfen.
    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4)
        i = end < 0 ? len : end + 3
      } else {
        const end = findTagEnd(html, lt + 2)
        i = end < 0 ? len : end + 1
      }
      continue
    }
    if (next === '?') {
      const end = findTagEnd(html, lt + 2)
      i = end < 0 ? len : end + 1
      continue
    }

    const closing = next === '/'
    const nameAt = lt + (closing ? 2 : 1)
    if (nameAt >= len || !NAME_START.test(html[nameAt])) {
      // Kein Tag, sondern ein einzelnes `<` im Text (z. B. „a < b").
      out.push('&lt;')
      plain.push('<')
      i = lt + 1
      continue
    }

    const name = readName(html, nameAt)
    const end = findTagEnd(html, nameAt + name.length)
    if (end < 0) {
      // Abgeschnittener Tag am Ende (`…<td`) – Rest verwerfen, nichts ausgeben.
      i = len
      continue
    }
    i = end + 1

    if (RAW_TEXT_TAGS.has(name)) {
      if (!closing) {
        // Inhalt bis zum passenden Ende-Tag mit wegwerfen.
        const lower = html.toLowerCase()
        const close = lower.indexOf(`</${name}`, i)
        if (close < 0) {
          i = len
        } else {
          const closeEnd = findTagEnd(html, close + 2 + name.length)
          i = closeEnd < 0 ? len : closeEnd + 1
        }
      }
      continue
    }

    if (!allowedTags.has(name)) continue // Tag weg, Inhalt bleibt
    if (closing && VOID_TAGS.has(name)) continue
    out.push(closing ? `</${name}>` : `<${name}>`)
  }

  const result = out.join('')

  // Zweiter Durchlauf: im Ergebnis darf jedes `<` nur ein erlaubter Tag ohne
  // Attribute sein. Schlägt das fehl, gibt es gar kein HTML mehr, sondern nur
  // noch den escapeten Text.
  if (!isPlainAllowlist(result, allowedTags)) return esc(plain.join(''))
  return result
}

/** Prüft, dass im gesäuberten HTML ausschließlich `<tag>`/`</tag>` vorkommt. */
function isPlainAllowlist(html: string, allowedTags: Set<string>): boolean {
  for (let i = html.indexOf('<'); i >= 0; i = html.indexOf('<', i + 1)) {
    const closing = html[i + 1] === '/'
    const nameAt = i + (closing ? 2 : 1)
    const name = readName(html, nameAt)
    if (!name || !allowedTags.has(name)) return false
    if (html[nameAt + name.length] !== '>') return false
  }
  return true
}

/** Deckel gegen riesige Vorschauen; `note` ist der Hinweis für den Besucher. */
function capHtml(html: string, note: string): string | null {
  return html.length > HTML_LIMIT ? generic(note) : null
}

/**
 * `fileUrl` ist die Adresse der Rohdatei in der Pfadfamilie der anfragenden Seite
 * (links.ts): `/f/<id>` bzw. `/f/<id>/<fid>` im eigenen Netz, `/<T>/d` bzw.
 * `/<T>/<fid>/d` über den Relay. Die fertige Vorschau enthält diese Adresse –
 * deshalb hat der Vorschau-Cache im Server die Familie im Schlüssel.
 */
export async function buildPreview(
  meta: ShareMeta,
  binPath: string,
  fileUrl: string
): Promise<string> {
  const ext = (meta.name.split('.').pop() ?? '').toLowerCase()
  const mime = meta.mime ?? ''
  // Landet in HTML-Attributen -> escapen, egal woher sie kommt.
  const url = esc(fileUrl)

  try {
    if (mime.startsWith('image/')) {
      return `<div class="preview"><img src="${url}" alt="${esc(meta.name)}"></div>`
    }
    if (mime.startsWith('video/')) {
      return `<div class="preview"><video src="${url}" controls playsinline preload="metadata"></video></div>`
    }
    if (mime.startsWith('audio/')) {
      return `<div class="preview preview--audio"><audio src="${url}" controls></audio></div>`
    }
    if (ext === 'pdf' || mime === 'application/pdf') {
      return `<iframe class="pdf" src="${url}" title="${esc(meta.name)}"></iframe>`
    }
    if (ext === 'docx' || mime.includes('wordprocessingml')) {
      return await docxPreview(binPath)
    }
    if (['xlsx', 'xls', 'csv'].includes(ext) || mime.includes('spreadsheet') || mime === 'text/csv') {
      return await sheetPreview(binPath, ext === 'csv' || mime === 'text/csv')
    }
    if (ext === 'zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed') {
      return await zipPreview(binPath)
    }
    if (TEXT_EXTS.has(ext) || mime.startsWith('text/')) {
      return await textPreview(binPath)
    }
  } catch {
    return generic('Die Vorschau ließ sich nicht erzeugen. Lad die Datei herunter, um sie zu öffnen.')
  }

  return generic('Für diese Art Datei gibt es keine Vorschau im Browser. Lad sie herunter, um sie zu öffnen.')
}

async function docxPreview(binPath: string): Promise<string> {
  const { size } = await fsp.stat(binPath)
  if (size > DOC_LIMIT) return generic('Das Dokument ist zu groß für die Vorschau. Lad es herunter, um es zu öffnen.')
  const mammoth = await loadMammoth()
  // Bilder gar nicht erst einlesen: `imgElement` mit leerem src heißt, mammoth
  // ruft nie `read()` auf – kein Megabyte-Base64 im Speicher. Das `<img>` selbst
  // entfernt die Allowlist ohnehin.
  const { value } = await mammoth.convertToHtml({ path: binPath }, {
    convertImage: mammoth.images.imgElement(async () => ({ src: '' }))
  })
  const clean = sanitizePreviewHtml(value, DOC_TAGS)
  const capped = capHtml(clean, 'Die Vorschau wäre zu groß. Lad die Datei herunter, um alles zu sehen.')
  if (capped) return capped
  return `<div class="doc">${clean || '<p>(leeres Dokument)</p>'}</div>`
}

/**
 * CSV-Sonderfall: `XLSX.readFile()` liest ohne BOM standardmäßig als cp1252 –
 * „Grün" wird zu „GrÃ¼n". Deshalb hier den Inhalt selbst dekodieren, statt der
 * Bibliothek eine Kodierung zu unterstellen: gültiges UTF-8 (mit oder ohne BOM
 * – `TextDecoder` entfernt eine BOM automatisch) gewinnt, sonst cp1252-Fallback
 * für ältere/Excel-typische Dateien (bisheriges Verhalten). `windows-1252` ist
 * in Node/Electron mit voller ICU-Unterstützung verfügbar; schlägt das aus
 * irgendeinem Grund fehl, tut's `latin1` (deckt densselben Zeichenbereich für
 * westeuropäische Umlaute ab) als letzte Rettung.
 */
function decodeCsv(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

async function sheetPreview(binPath: string, isCsv: boolean): Promise<string> {
  const { size } = await fsp.stat(binPath)
  if (size > SHEET_LIMIT) return generic('Die Tabelle ist zu groß für die Vorschau. Lad sie herunter, um sie zu öffnen.')
  const XLSX = await loadXlsx()
  const wb = isCsv
    ? XLSX.read(decodeCsv(await fsp.readFile(binPath)), { type: 'string' })
    : XLSX.readFile(binPath)
  const names = wb.SheetNames.slice(0, 5)
  let html = ''
  for (const name of names) {
    const full = XLSX.utils.sheet_to_html(wb.Sheets[name])
    const m = full.match(/<table[\s\S]*<\/table>/i)
    const table = m ? sanitizePreviewHtml(m[0], TABLE_TAGS) : ''
    html += `<div class="sheet__name">${esc(name)}</div>${table}`
  }
  if (wb.SheetNames.length > names.length) {
    html += `<div class="sheet__more">… und ${wb.SheetNames.length - names.length} weitere Blätter</div>`
  }
  const capped = capHtml(html, 'Die Vorschau wäre zu groß. Lad die Datei herunter, um alles zu sehen.')
  if (capped) return capped
  return `<div class="sheet">${html}</div>`
}

async function textPreview(binPath: string): Promise<string> {
  const { size } = await fsp.stat(binPath)
  let content: string
  if (size <= TEXT_LIMIT) {
    content = await fsp.readFile(binPath, 'utf-8')
  } else {
    const fh = await fsp.open(binPath, 'r')
    const buf = Buffer.alloc(TEXT_LIMIT)
    await fh.read(buf, 0, TEXT_LIMIT, 0)
    await fh.close()
    content = buf.toString('utf-8') + '\n\n… (gekürzt. Den ganzen Text bekommst du beim Herunterladen.)'
  }
  return `<pre class="text">${esc(content)}</pre>`
}

function formatSize(bytes: number): string {
  if (bytes === 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

interface ZipNode {
  name: string
  size: number
  dir: boolean
  children: Map<string, ZipNode>
}

/** ZIP: Ordnerbaum des Archivs anzeigen, ohne die Datei komplett zu laden. */
async function zipPreview(binPath: string): Promise<string> {
  const listing = await listZipEntries(binPath)
  if (!listing || listing.entries.length === 0) {
    return generic('Der Inhalt dieses Archivs lässt sich nicht anzeigen.')
  }

  // Pfadliste in einen Baum überführen.
  const root: ZipNode = { name: '', size: 0, dir: true, children: new Map() }
  for (const e of listing.entries as ZipEntry[]) {
    const parts = e.path.split('/').filter(Boolean)
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1
      const key = parts[i]
      let child = node.children.get(key)
      if (!child) {
        child = { name: key, size: 0, dir: !isLeaf || e.dir, children: new Map() }
        node.children.set(key, child)
      }
      if (isLeaf && !e.dir) child.size = e.size
      node = child
    }
  }

  const renderNodes = (node: ZipNode, depth: number): string => {
    const kids = [...node.children.values()].sort(
      (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'de')
    )
    let html = '<ul class="zt">'
    for (const k of kids) {
      if (k.dir) {
        html += `<li><details${depth === 0 ? ' open' : ''}><summary>${ICON_FOLDER}${esc(k.name)}<span class="zt__count">${k.children.size}</span></summary>${renderNodes(k, depth + 1)}</details></li>`
      } else {
        html += `<li class="zt__file">${ICON_FILE_SM}${esc(k.name)}<span class="zt__size">${formatSize(k.size)}</span></li>`
      }
    }
    return html + '</ul>'
  }

  const truncated =
    listing.total > listing.entries.length
      ? `<div class="zip__more">… und ${listing.total - listing.entries.length} weitere Einträge, im Download sind alle dabei.</div>`
      : ''

  return `<div class="zip"><div class="zip__head">Inhalt des Archivs · ${listing.total} Einträge</div><div class="zip__tree">${renderNodes(root, 0)}</div>${truncated}</div>`
}

/** Linien-Symbole statt Emojis (gleicher Stil wie die Seiten-Icons). */
const ICON_FOLDER = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>`
const ICON_FILE_SM = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/></svg>`
const ICON_FILE_LG = `<svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/></svg>`

function generic(note?: string): string {
  return `<div class="preview"><div class="glyph">${ICON_FILE_LG}</div>${
    note ? `<div class="preview__note">${esc(note)}</div>` : ''
  }</div>`
}
