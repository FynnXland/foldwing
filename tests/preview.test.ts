import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  openSync,
  ftruncateSync,
  closeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { createRequire } from 'node:module'
import { buildPreview, sanitizePreviewHtml, TABLE_TAGS, DOC_TAGS } from '../src/main/preview'
import { crc32 } from '../src/main/zip-write'
import type { ShareMeta } from '../src/main/store'

// xlsx/mammoth hier NICHT statisch importieren: Der erste Test prüft, dass erst
// buildPreview sie lädt (preview.ts lädt sie bei Bedarf, um RAM im Leerlauf zu sparen).

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'foldwing-preview-test-'))
}

/** Ist das (CommonJS-)Paket schon geladen? CJS landet auch per import() im require-Cache. */
function isLoaded(pkg: string): boolean {
  const cache = createRequire(import.meta.url).cache
  return Object.keys(cache).some((k) => k.includes(`${sep}node_modules${sep}${pkg}${sep}`))
}

/**
 * Minimale .docx (ZIP mit Methode „stored") aus Absätzen – genug für mammoth,
 * ohne zusätzliche Test-Abhängigkeit.
 */
function writeDocx(path: string, paragraphs: string[]): void {
  const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xml(p)}</w:t></w:r></w:p>`)
    .join('')
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const parts: [string, string][] = [
    [
      '[Content_Types].xml',
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    ],
    [
      '_rels/.rels',
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    ],
    [
      'word/document.xml',
      `${head}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
    ]
  ]
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of parts) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // benötigte Version
    local.writeUInt16LE(0x21, 12) // Datum 1980-01-01, Methode 0 = stored
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(parts.length, 8)
  eocd.writeUInt16LE(parts.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  writeFileSync(path, Buffer.concat([...chunks, cd, eocd]))
}

function meta(partial: Partial<ShareMeta> & { name: string }): ShareMeta {
  return {
    id: 'test-id',
    mime: '',
    size: 0,
    createdAt: Date.now(),
    ...partial
  }
}

// Realer Angriffs-Payload, mit dem xlsx' `sheet_to_html` (unescaped `data-v`)
// nachweislich aus dem Attribut ausbricht – siehe Kommentar in preview.ts.
const ATTR_BREAKOUT_PAYLOAD =
  'a"><meta http-equiv="refresh" content="0;url=https://evil.example"><b x="'

/* ------------------------------------------------------------------ */
/* (0) Bibliotheken erst bei Bedarf – MUSS der erste Test sein          */
/* ------------------------------------------------------------------ */

test('preview.ts lädt xlsx und mammoth erst, wenn eine solche Vorschau gebraucht wird', async () => {
  assert.equal(isLoaded('xlsx'), false, 'xlsx schon beim Import geladen')
  assert.equal(isLoaded('mammoth'), false, 'mammoth schon beim Import geladen')

  const dir = makeTmpDir()
  try {
    // Text-Vorschau braucht keine der beiden Bibliotheken.
    const txt = join(dir, 'a.txt')
    writeFileSync(txt, 'hallo')
    await buildPreview(meta({ name: 'a.txt', mime: 'text/plain' }), txt, '/f/test01')
    assert.equal(isLoaded('xlsx'), false)
    assert.equal(isLoaded('mammoth'), false)

    const csv = join(dir, 'a.csv')
    writeFileSync(csv, 'a;b\n1;2\n')
    const sheet = await buildPreview(meta({ name: 'a.csv', mime: 'text/csv' }), csv, '/f/test01')
    assert.match(sheet, /<table>/)
    assert.equal(isLoaded('xlsx'), true)
    assert.equal(isLoaded('mammoth'), false)

    const docx = join(dir, 'a.docx')
    writeDocx(docx, ['Hallo'])
    const doc = await buildPreview(meta({ name: 'a.docx' }), docx, '/f/test01')
    assert.match(doc, /<p>Hallo<\/p>/)
    assert.equal(isLoaded('mammoth'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* (a) sanitizePreviewHtml direkt                                      */
/* ------------------------------------------------------------------ */

test('sanitizePreviewHtml: Attribut-Ausbruch (meta-refresh) wird neutralisiert', () => {
  const html = `<table><tr><td data-v="${ATTR_BREAKOUT_PAYLOAD}">cell</td></tr></table>`
  const clean = sanitizePreviewHtml(html, TABLE_TAGS)

  assert.doesNotMatch(clean, /<meta/i)
  assert.doesNotMatch(clean, /data-v/)
  assert.doesNotMatch(clean, /=/) // keine Attribute mehr im Ergebnis, egal welches
})

test('sanitizePreviewHtml: <a href="javascript:…"> fällt komplett raus (kein a in DOC_TAGS)', () => {
  const html = '<p><a href="javascript:alert(1)">click</a></p>'
  const clean = sanitizePreviewHtml(html, DOC_TAGS)

  assert.doesNotMatch(clean, /<a[\s>]/i)
  assert.doesNotMatch(clean, /javascript:/i)
  assert.match(clean, /click/) // Text bleibt, nur das Tag verschwindet
})

test('sanitizePreviewHtml: Groß-/Kleinschreibung und unquotierte Attribute normalisiert', () => {
  const html = '<TABLE ID=x><TR><TD>hi</TD></TR></TABLE>'
  const clean = sanitizePreviewHtml(html, TABLE_TAGS)

  assert.equal(clean, '<table><tr><td>hi</td></tr></table>')
})

/* ------------------------------------------------------------------ */
/* (b) End-to-End über buildPreview mit echter .xlsx                   */
/* ------------------------------------------------------------------ */

test('buildPreview: .xlsx mit Payload-Zelle – kein <meta>, Inhalt bleibt sichtbar', async () => {
  const dir = makeTmpDir()
  try {
    // Dynamisch (siehe Kopf der Datei); CommonJS -> API auf `default`.
    const mod = await import('xlsx')
    const XLSX = mod.default ?? mod
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([[ATTR_BREAKOUT_PAYLOAD]])
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const filePath = join(dir, 'payload.xlsx')
    XLSX.writeFile(wb, filePath)

    const html = await buildPreview(meta({ name: 'payload.xlsx' }), filePath, '/f/test01')

    assert.doesNotMatch(html, /<meta/i)
    assert.match(html, /evil\.example/) // Zellinhalt bleibt als reiner Text sichtbar
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* (b2) Word-Vorschau über das nachgeladene mammoth                    */
/* ------------------------------------------------------------------ */

test('buildPreview: .docx wird gerendert, Markup aus dem Text bleibt reiner Text', async () => {
  const dir = makeTmpDir()
  try {
    const filePath = join(dir, 'brief.docx')
    writeDocx(filePath, ['Grüße aus Kiel', '<script>alert(1)</script>'])

    const html = await buildPreview(meta({ name: 'brief.docx' }), filePath, '/f/test01')

    assert.match(html, /^<div class="doc">/)
    assert.match(html, /<p>Grüße aus Kiel<\/p>/)
    assert.match(html, /<p>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/)
    assert.doesNotMatch(html, /<script/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* (c)-(e) CSV-Zeichensatz                                             */
/* ------------------------------------------------------------------ */

test('buildPreview: .csv UTF-8 ohne BOM wird korrekt gelesen (kein Mojibake)', async () => {
  const dir = makeTmpDir()
  try {
    const filePath = join(dir, 'utf8.csv')
    writeFileSync(filePath, Buffer.from('Grün;Größe;Übersicht\n1;2;3\n', 'utf-8'))

    const html = await buildPreview(meta({ name: 'utf8.csv', mime: 'text/csv' }), filePath, '/f/test01')

    assert.match(html, /Grün/)
    assert.match(html, /Größe/)
    assert.match(html, /Übersicht/)
    assert.doesNotMatch(html, /GrÃ/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildPreview: .csv UTF-8 mit BOM wird korrekt gelesen', async () => {
  const dir = makeTmpDir()
  try {
    const filePath = join(dir, 'bom.csv')
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Grün;Größe;Übersicht\n1;2;3\n', 'utf-8')
    ])
    writeFileSync(filePath, withBom)

    const html = await buildPreview(meta({ name: 'bom.csv', mime: 'text/csv' }), filePath, '/f/test01')

    assert.match(html, /Grün/)
    assert.doesNotMatch(html, /GrÃ/)
    // BOM darf nicht als sichtbares Zeichen in der Ausgabe landen. Über
    // fromCharCode statt eines rohen BOM-Bytes im Quelltext (siehe CLAUDE.md
    // §6 zu Steuerzeichen in Regex-/String-Literalen).
    assert.ok(!html.includes(String.fromCharCode(0xfeff)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildPreview: .csv cp1252-kodiert fällt sauber auf cp1252 zurück', async () => {
  const dir = makeTmpDir()
  try {
    const filePath = join(dir, 'cp1252.csv')
    // 'latin1' erzeugt für diese Umlaute dieselben Bytes wie cp1252 (0xA0-0xFF
    // sind in beiden Kodierungen identisch) – damit ungültiges UTF-8 simuliert.
    writeFileSync(filePath, Buffer.from('Grün;Größe;Übersicht\n1;2;3\n', 'latin1'))

    const html = await buildPreview(meta({ name: 'cp1252.csv', mime: 'text/csv' }), filePath, '/f/test01')

    assert.match(html, /Grün/)
    assert.doesNotMatch(html, /GrÃ/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* (f) Text-Vorschau escaped                                           */
/* ------------------------------------------------------------------ */

test('buildPreview: Text-Vorschau escaped <script> als reinen Text', async () => {
  const dir = makeTmpDir()
  try {
    const filePath = join(dir, 'x.txt')
    writeFileSync(filePath, '<script>alert(1)</script>')

    const html = await buildPreview(meta({ name: 'x.txt', mime: 'text/plain' }), filePath, '/f/test01')

    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* (g) SHEET_LIMIT greift vor dem Lesen                                 */
/* ------------------------------------------------------------------ */

test('buildPreview: Datei über dem Tabellen-Größendeckel zeigt Hinweis statt Tabelle', async () => {
  const dir = makeTmpDir()
  try {
    const filePath = join(dir, 'big.csv')
    // Sparse-Datei über SHEET_LIMIT (20 MiB, siehe preview.ts) anlegen, ohne
    // wirklich 20 MB zu schreiben – der Größendeckel greift schon vor dem Lesen,
    // der Inhalt ist für diesen Test irrelevant.
    const fd = openSync(filePath, 'w')
    ftruncateSync(fd, 20 * 1024 * 1024 + 1)
    closeSync(fd)

    const html = await buildPreview(meta({ name: 'big.csv', mime: 'text/csv' }), filePath, '/f/test01')

    assert.doesNotMatch(html, /<table/i)
    assert.match(html, /zu groß für die Vorschau/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
