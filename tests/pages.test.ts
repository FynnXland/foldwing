import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sharePage, landingPage, bundlePage } from '../src/main/pages'
import { lanLinks, relayLinks } from '../src/main/links'
import { BUNDLE_MIME } from '../src/main/store'
import type { ShareMeta } from '../src/main/store'
import { APP_NAME } from '../src/main/brand'

/** LAN-Pfadfamilie einer Freigabe (wie bisher /s/ und /f/). */
const L = (m: ShareMeta) => lanLinks(m.id)

test('sharePage/landingPage: niemals <script im Markup (CSP: script-src none)', () => {
  const meta: ShareMeta = {
    id: 'abc123',
    name: '<img src=x onerror=1>.png',
    mime: 'image/png',
    size: 2048,
    createdAt: Date.now()
  }
  const share = sharePage(meta, '<div class="preview">Vorschau</div>', L(meta))
  assert.doesNotMatch(share.toLowerCase(), /<script/)

  const landing = landingPage('<b>Nachricht</b> mit "Anführungszeichen"')
  assert.doesNotMatch(landing.toLowerCase(), /<script/)
})

test('sharePage: escaped einen bösartigen Dateinamen (gespeichertes XSS)', () => {
  const meta: ShareMeta = {
    id: 'abc123',
    name: '<img src=x onerror=1>.png',
    mime: 'image/png',
    size: 2048,
    createdAt: Date.now()
  }
  const html = sharePage(meta, '<div class="preview">Vorschau</div>', L(meta))
  assert.doesNotMatch(html, /<img src=x onerror=1>/)
  assert.match(html, /&lt;img src=x onerror=1&gt;\.png/)
})

test('landingPage: escaped die übergebene Nachricht', () => {
  const html = landingPage('<b>Nachricht</b> mit "Anführungszeichen"')
  assert.doesNotMatch(html, /<b>Nachricht<\/b>/)
  assert.match(html, /&lt;b&gt;Nachricht&lt;\/b&gt;/)
  assert.match(html, /&quot;Anführungszeichen&quot;/)
})

test('landingPage: Standardtext ohne Nachricht', () => {
  const html = landingPage()
  assert.match(html, /Hier gibt's nichts zu sehen/)
})

// ————— Sammlungen: mehrere Dateien unter einem Link —————

const BUNDLE: ShareMeta = {
  id: 'BundleId01',
  name: '3 Dateien',
  mime: BUNDLE_MIME,
  size: 3072,
  createdAt: Date.parse('2026-01-02T10:00:00Z'),
  files: [
    { fid: 'aaa111', name: 'urlaub.png', mime: 'image/png', size: 1024 },
    { fid: 'bbb222', name: 'vertrag.pdf', mime: 'application/pdf', size: 1024 },
    { fid: 'ccc333', name: 'liste.csv', mime: 'text/csv', size: 1024 }
  ]
}

test('sharePage ohne opts: unverändertes Grundgerüst der Einzelfreigabe', () => {
  const meta: ShareMeta = {
    id: 'abc123',
    name: 'bild.png',
    mime: 'image/png',
    size: 2048,
    createdAt: Date.now()
  }
  const html = sharePage(meta, '<div class="preview">Vorschau</div>', L(meta))
  assert.match(html, /<h1 class="fname">bild\.png<\/h1>/)
  assert.match(html, /href="\/f\/abc123\?dl=1"/)
  assert.match(html, /href="\/f\/abc123"/)
  // (die .backlink-Regel steht immer im CSS – hier zählt das fehlende Element)
  assert.doesNotMatch(html, /<a class="backlink"/)
  assert.doesNotMatch(html, /Zurück zu allen Dateien/)
  // keine Teildatei-URLs, wenn keine Sammlung im Spiel ist
  assert.doesNotMatch(html, /\/f\/abc123\/[A-Za-z0-9]/)
})

test('sharePage mit opts.file: Titel, /f/<id>/<fid>-Links und Zurück-Link', () => {
  const file = BUNDLE.files![1]
  const html = sharePage(BUNDLE, '<div class="preview">PDF</div>', L(BUNDLE), { file })
  assert.match(html, /<h1 class="fname">vertrag\.pdf<\/h1>/)
  assert.ok(html.includes(`<title>vertrag.pdf · ${APP_NAME}</title>`))
  assert.match(html, /href="\/f\/BundleId01\/bbb222\?dl=1"/)
  assert.match(html, /href="\/f\/BundleId01\/bbb222"/)
  assert.match(html, /<a class="backlink" href="\/s\/BundleId01">← Zurück zu allen Dateien<\/a>/)
  // Größe und Art stammen aus der Teildatei, nicht aus der Sammlung – lesbar statt
  // rohem MIME-Typ, mit deutschem Dezimalkomma
  assert.match(html, /1,0 KB · PDF/)
  assert.doesNotMatch(html, /application\/pdf ·/)
  assert.doesNotMatch(html, /<h1 class="fname">3 Dateien<\/h1>/)
})

test('sharePage mit opts.file: Warnbox nur bei ausführbarer Teildatei', () => {
  const exe = sharePage(BUNDLE, '', L(BUNDLE), {
    file: { fid: 'ddd444', name: 'setup.exe', mime: 'application/octet-stream', size: 10 }
  })
  assert.match(exe, /class="warnbox"/)
  assert.match(exe, /ausführbar/)

  const img = sharePage(BUNDLE, '', L(BUNDLE), { file: BUNDLE.files![0] })
  assert.doesNotMatch(img, /class="warnbox"/)
})

test('bundlePage: Übersicht listet alle Dateien mit Ansicht- und Download-Link', () => {
  const html = bundlePage(BUNDLE, L(BUNDLE))

  assert.match(html, /<h1 class="fname">3 Dateien<\/h1>/)
  // Gesamtgröße (deutsches Dezimalkomma)
  assert.match(html, /3,0 KB/)
  // "Alle herunterladen" (ZIP) auf die Sammlung selbst
  assert.match(html, /href="\/f\/BundleId01\?dl=1"/)
  assert.match(html, /Alle als ZIP herunterladen/)

  for (const f of BUNDLE.files!) {
    assert.match(html, new RegExp(`href="/s/BundleId01/${f.fid}"`))
    assert.match(html, new RegExp(`href="/f/BundleId01/${f.fid}\\?dl=1"`))
    assert.ok(html.includes(f.name), `Dateiname fehlt: ${f.name}`)
  }

  // Bild als echtes Thumbnail, PDF/CSV nicht
  assert.match(html, /<img src="\/f\/BundleId01\/aaa111"/)
  assert.doesNotMatch(html, /<img src="\/f\/BundleId01\/bbb222"/)
  assert.doesNotMatch(html, /<img src="\/f\/BundleId01\/ccc333"/)
  // Video/Audio werden nie eingebettet
  assert.doesNotMatch(html, /<video|<audio/)

  // Fußzeile im eigenen Netz ohne Links (kein Impressum mehr), Hinweiszeile wie auf der Einzelseite
  assert.ok(html.includes(`<div class="foot">Geteilt mit ${APP_NAME}</div>`))
  assert.doesNotMatch(html, /impressum/i)
  assert.match(html, /class="hint"/)
})

test('bundlePage/sharePage: kein <script, auch bei bösartigen Eingaben', () => {
  const evil: ShareMeta = {
    id: 'Evil01',
    name: '<script>alert(1)</script>',
    mime: BUNDLE_MIME,
    size: 4,
    createdAt: Date.now(),
    files: [
      { fid: 'x1', name: '<script>alert(2)</script>.png', mime: 'image/png', size: 2 },
      { fid: 'x2', name: 'a.txt', mime: 'text/html"><script>bad()</script>', size: 2 }
    ]
  }
  assert.doesNotMatch(bundlePage(evil, L(evil)).toLowerCase(), /<script/)
  assert.doesNotMatch(sharePage(evil, '', L(evil), { file: evil.files![0] }).toLowerCase(), /<script/)
  assert.doesNotMatch(sharePage(evil, '', L(evil), { file: evil.files![1] }).toLowerCase(), /<script/)
})

test('bundlePage: Dateinamen und MIME landen escaped, nie als Attribut', () => {
  const evil: ShareMeta = {
    id: 'Evil02',
    name: '2 Dateien',
    mime: BUNDLE_MIME,
    size: 4,
    createdAt: Date.now(),
    files: [
      { fid: 'y1', name: '<img src=x onerror=alert(1)>.png', mime: 'image/png', size: 2 },
      { fid: 'y2', name: '" onmouseover="x', mime: 'text/html"><script>', size: 2 }
    ]
  }
  const html = bundlePage(evil, L(evil))

  // kein echtes Tag und kein Attribut aus dem Namen
  assert.doesNotMatch(html, /<img[^>]*onerror/i)
  assert.doesNotMatch(html, /onmouseover="/i)
  assert.doesNotMatch(html, /<img src=x/)
  // Name steht escaped da
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\.png/)
  assert.match(html, /&quot; onmouseover=&quot;x/)

  // derselbe Name in der Einzelansicht der Teildatei
  const single = sharePage(evil, '', L(evil), { file: evil.files![1] })
  assert.doesNotMatch(single, /onmouseover="/i)
  assert.match(single, /&quot; onmouseover=&quot;x/)
  // Der (bösartige) MIME-Typ steht gar nicht mehr auf der Seite – die Meta-Zeile
  // zeigt nur noch die lesbare Art.
  assert.doesNotMatch(single, /text\/html/)
  assert.match(single, /2 B · Text ·/)
  assert.doesNotMatch(single.toLowerCase(), /<script/)
})

test('bundlePage: genau eine Warnbox, wenn eine von drei Dateien ausführbar ist', () => {
  const meta: ShareMeta = {
    id: 'Warn01',
    name: '3 Dateien',
    mime: BUNDLE_MIME,
    size: 30,
    createdAt: Date.now(),
    files: [
      { fid: 'p1', name: 'foto.jpg', mime: 'image/jpeg', size: 10 },
      { fid: 'p2', name: 'setup.exe', mime: 'application/octet-stream', size: 10 },
      { fid: 'p3', name: 'notiz.txt', mime: 'text/plain', size: 10 }
    ]
  }
  const html = bundlePage(meta, L(meta))
  assert.equal(html.match(/class="warnbox"/g)?.length, 1)
  assert.match(html, /Eine Datei ist ausführbar: setup\.exe/)
})

test('bundlePage: 1 Datei und 30 Dateien ergeben gültige Seiten', () => {
  const oneMeta: ShareMeta = {
    id: 'One001',
    name: '1 Datei',
    mime: BUNDLE_MIME,
    size: 5,
    createdAt: Date.now(),
    files: [{ fid: 'o1', name: 'einzeln.pdf', mime: 'application/pdf', size: 5 }]
  }
  const one = bundlePage(oneMeta, L(oneMeta))
  assert.match(one, /einzeln\.pdf/)
  assert.match(one, /href="\/f\/One001\/o1\?dl=1"/)
  assert.equal(one.match(/class="frow frow--/g)?.length, 1)

  const many: ShareMeta = {
    id: 'Many01',
    name: '30 Dateien',
    mime: BUNDLE_MIME,
    size: 30 * 100,
    createdAt: Date.now(),
    files: Array.from({ length: 30 }, (_, i) => ({
      fid: `f${String(i).padStart(3, '0')}`,
      name: `datei-${i}.png`,
      mime: 'image/png',
      size: 100
    }))
  }
  const html = bundlePage(many, L(many))
  assert.equal(html.match(/class="frow frow--/g)?.length, 30)
  for (let i = 0; i < 30; i++) assert.ok(html.includes(`datei-${i}.png`), `fehlt: datei-${i}.png`)
  assert.doesNotMatch(html.toLowerCase(), /<script/)
})

// ————— Relay-Pfadfamilie —————

const DEVICE = 'Dev12345'

/** Enthält das HTML den Text wörtlich? (Pfade mit ? und . lesen sich so leichter als Regex.) */
function has(html: string, text: string): void {
  assert.ok(html.includes(text), `fehlt: ${text}`)
}

test('sharePage über den Relay: nur Relay-Pfade, Schriften unter /<T>/_font, Relay-Fußzeile', () => {
  const meta: ShareMeta = { id: 'AbCdEf1234', name: 'bild.png', mime: 'image/png', size: 10, createdAt: 0 }
  const T = DEVICE + meta.id
  const html = sharePage(meta, '<div class="preview">Vorschau</div>', relayLinks(DEVICE, meta.id))
  has(html, `href="/${T}/d?dl=1"`)
  has(html, `href="/${T}/d" target="_blank"`)
  has(html, `url('/${T}/_font/Geist-Variable.woff2')`)
  has(html, `url('/${T}/_font/GeistMono-Variable.woff2')`)
  assert.doesNotMatch(html, /"\/f\/|"\/s\/|'\/_font\//, 'keine LAN-Pfade auf einer Relay-Seite')
  has(html, '<a class="foot__link" href="/_/impressum">Impressum</a>')
  has(html, '<a class="foot__link" href="/_/datenschutz">Datenschutz</a>')
  has(html, `<a class="foot__link" href="/_/melden?l=${T}">Melden</a>`)
  // Reihenfolge wie im abgestimmten Text: Über · Melden · Impressum · Datenschutz
  has(html, `Geteilt mit ${APP_NAME} · <a class="foot__link" href="/_/">Über foldwing.online</a> · <a class="foot__link" href="/_/melden?l=${T}">Melden</a>`)
})

test('bundlePage über den Relay: Teildateien unter /<T>/<F> und /<T>/<F>/d', () => {
  const T = DEVICE + BUNDLE.id
  const html = bundlePage(BUNDLE, relayLinks(DEVICE, BUNDLE.id))
  has(html, `href="/${T}/d?dl=1"`)
  for (const f of BUNDLE.files!) {
    has(html, `href="/${T}/${f.fid}"`)
    has(html, `href="/${T}/${f.fid}/d?dl=1"`)
  }
  has(html, `<img src="/${T}/aaa111/d"`)
  assert.doesNotMatch(html, /"\/f\/|"\/s\//)

  const part = sharePage(BUNDLE, '', relayLinks(DEVICE, BUNDLE.id), { file: BUNDLE.files![1] })
  has(part, `<a class="backlink" href="/${T}">`)
  has(part, `href="/${T}/bbb222/d?dl=1"`)
})

test('landingPage: Schriften und Fußzeile folgen der Pfadfamilie', () => {
  const lan = landingPage()
  has(lan, `url('/_font/Geist-Variable.woff2')`)
  has(lan, `<div class="foot">Geteilt mit ${APP_NAME}</div>`)
  const relay = landingPage('weg', relayLinks(DEVICE, 'AbCdEf1234'))
  has(relay, `url('/Dev12345AbCdEf1234/_font/Geist-Variable.woff2')`)
  has(relay, 'href="/_/melden?l=Dev12345AbCdEf1234"')
})
