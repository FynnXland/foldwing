import type { ShareFile, ShareMeta } from './store'
import type { ShareLinks } from './links'
import { APP_NAME, logoSvg } from './brand'

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Größe lesbar machen, mit deutschem Dezimalkomma (die Seiten sind deutsch). */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`
}

/** Die Marke im Seitenkopf (Papierflieger auf blauer Kachel, siehe brand.ts). */
const LOGO_SVG = logoSvg(28)

const ICON_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"/><path d="M8 12l4 4 4-4"/><path d="M4 19v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1"/></svg>`

const ICON_ALERT = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5h.01"/></svg>`

const ICON_EYE = `<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`

/**
 * Linien-Icon im Stil von ICON_DOWNLOAD bauen. `shapes` ist eine mit `|`
 * getrennte Liste aus Pfad-Daten und `circle:cx,cy,r` – dasselbe Kurzformat wie
 * im Renderer (src/renderer/src/components/Icon.tsx). Nur interne Konstanten,
 * nie Nutzereingaben.
 */
function lineIcon(shapes: string, size: number): string {
  const body = shapes
    .split('|')
    .map((part) => {
      if (part.startsWith('circle:')) {
        const [cx, cy, r] = part.slice(7).split(',')
        return `<circle cx="${cx}" cy="${cy}" r="${r}"/>`
      }
      return `<path d="${part}"/>`
    })
    .join('')
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

/** Grobe Dateiarten für Kachel-Icon, Farbe und Beschriftung. */
type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'doc' | 'sheet' | 'zip' | 'text' | 'file'

const KIND_SHAPES: Record<Kind, string> = {
  image: 'M3 5h18v14H3z|circle:8.5,10,1.5|M21 16l-5-5-9 8',
  video: 'M15 8l6-3v14l-6-3M3 6h12v12H3z',
  audio: 'M9 18V6l11-2v12|circle:6,18,3|circle:17,16,3',
  pdf: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 13h6M9 17h6',
  doc: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 13h6M9 17h6',
  sheet: 'M3 5h18v14H3zM3 10h18M9 5v14',
  zip: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  text: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 13h4',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6'
}

/** Kurze deutsche Bezeichnung der Art, wie sie unter dem Dateinamen steht. */
const KIND_LABEL: Record<Kind, string> = {
  image: 'Bild',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
  doc: 'Dokument',
  sheet: 'Tabelle',
  zip: 'Archiv',
  text: 'Text',
  file: 'Datei'
}

/** Art einer Datei aus MIME und Endung ableiten (gleiche Logik wie im Renderer). */
function detectKind(name: string, mime: string): Kind {
  const m = String(mime ?? '')
  const n = String(name ?? '')
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf' || /\.pdf$/i.test(n)) return 'pdf'
  if (/\.(zip|rar|7z|tar|gz)$/i.test(n) || m.includes('zip')) return 'zip'
  if (/\.(xlsx?|csv)$/i.test(n)) return 'sheet'
  if (/\.(docx?|odt|rtf)$/i.test(n)) return 'doc'
  if (m.startsWith('text/') || /\.(txt|md|json|ya?ml|xml|ts|tsx|js|jsx|css|html?|py|sh|ini|log)$/i.test(n))
    return 'text'
  return 'file'
}

/* Design-System wie in der App: kühle Neutrals, ein Blau, Geist (selbst gehostet).
   Hell ist Standard, Dunkel folgt der Systemeinstellung, ganz ohne Skript.
   Alle Text-Paarungen ≥ 4,5:1 (AA), nachgemessen. */
function fontCss(fontBase: string): string {
  // fontBase kommt aus links.ts (nur base62 und feste Teile), trotzdem escapen.
  const b = escapeHtml(fontBase)
  return `
  @font-face {
    font-family: 'Geist'; src: url('${b}/Geist-Variable.woff2') format('woff2');
    font-weight: 100 900; font-style: normal; font-display: swap;
  }
  @font-face {
    font-family: 'Geist Mono'; src: url('${b}/GeistMono-Variable.woff2') format('woff2');
    font-weight: 100 900; font-style: normal; font-display: swap;
  }`
}

const BASE_CSS = `
  :root {
    --accent: #2563eb; --accent-hover: #1d4fd0; --accent-soft: #eef4ff; --accent-text: #1d4fd0;
    --on-accent: #ffffff; --focus: #2563eb;
    --bg-base: #f6f8fa; --bg-subtle: #eef1f4;
    --surface-card: #ffffff; --surface-sunken: #f6f8fa;
    --border-subtle: #e5e9ee; --border-default: #d8dee6; --border-control: #8792a0;
    --text-primary: #151a20; --text-secondary: #4c5763; --text-tertiary: #5d6875;
    --warning-fg: #93560a; --warning-bg: #fdf2e0;
    --kind-image: #2563eb; --kind-video: #7c3aed; --kind-pdf: #c0392b; --kind-doc: #1d4fd0;
    --kind-text: #1d4fd0; --kind-sheet: #0f7a4f; --kind-zip: #a16207; --kind-audio: #be185d;
    --kind-file: #5d6875;
    --shadow-xs: 0 1px 2px rgba(21,26,32,.06);
    --shadow-md: 0 4px 12px rgba(21,26,32,.07), 0 1px 3px rgba(21,26,32,.06);
    --font-sans: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    --font-mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --accent: #5c86f8; --accent-hover: #8fb0ff; --accent-soft: rgba(37,99,235,.2); --accent-text: #8fb0ff;
      --on-accent: #0c0f13; --focus: #8fb0ff;
      --bg-base: #0c0f13; --bg-subtle: #151a20;
      --surface-card: #151a20; --surface-sunken: #0a0d11;
      --border-subtle: rgba(255,255,255,.07); --border-default: rgba(255,255,255,.12); --border-control: #6b7684;
      --text-primary: #eef1f5; --text-secondary: #a3acb8; --text-tertiary: #8a94a2;
      --warning-fg: #e0a13c; --warning-bg: rgba(217,138,26,.16);
      --kind-image: #7da0ff; --kind-video: #b39dff; --kind-pdf: #ff8a80; --kind-doc: #8fb0ff;
      --kind-text: #8fb0ff; --kind-sheet: #4fd1a1; --kind-zip: #f0b34a; --kind-audio: #f48fb8;
      --kind-file: #a3acb8;
      --shadow-xs: 0 1px 2px rgba(0,0,0,.4);
      --shadow-md: 0 4px 14px rgba(0,0,0,.5), 0 1px 3px rgba(0,0,0,.4);
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: var(--bg-base); color: var(--text-primary);
    font-family: var(--font-sans); font-size: 15px; line-height: 1.45;
  }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }

  /* Kopfzeile mit Marke */
  .topbar {
    display: flex; align-items: center;
    height: 56px; padding: 0 24px;
    border-bottom: 1px solid var(--border-subtle); background: var(--surface-card);
  }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .brand svg { display: block; flex-shrink: 0; }
  .brand__name { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; }

  .wrap { max-width: 780px; margin: 0 auto; padding: 32px 20px 48px; }

  /* Titelzeile: wer, Dateiname, Meta + Aktionen */
  .head {
    display: flex; align-items: flex-end; justify-content: space-between;
    gap: 16px; margin-bottom: 18px; flex-wrap: wrap;
  }
  .eyebrow { font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
  .fname {
    margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0.01em;
    line-height: 1.2; word-break: break-word;
  }
  .meta { color: var(--text-secondary); font-size: 13px; margin-top: 6px; }
  .head__actions { display: flex; gap: 10px; flex-wrap: wrap; }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer;
    height: 44px; padding: 0 16px; border-radius: 10px;
    border: 1px solid var(--border-default); background: var(--surface-card);
    color: var(--text-primary); font-family: var(--font-sans);
    font-size: 15px; font-weight: 500; line-height: 1;
    text-decoration: none; white-space: nowrap;
  }
  .btn:hover { background: var(--bg-subtle); }
  .btn--primary { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 600; }
  .btn--primary:hover { background: var(--accent-hover); }

  /* Vorschau-Karte */
  .card {
    background: var(--surface-card); border: 1px solid var(--border-subtle);
    border-radius: 16px; overflow: hidden; box-shadow: var(--shadow-md);
  }
  .preview {
    background: var(--surface-sunken); display: grid; place-items: center;
    min-height: 200px; max-height: 70vh; overflow: hidden;
  }
  .preview img, .preview video {
    max-width: 100%; max-height: 70vh; display: block; object-fit: contain;
  }
  /* Sehr kleine Bilder nicht am Rand kleben lassen. */
  .preview img { margin: 12px; max-width: calc(100% - 24px); }
  .preview--audio { min-height: 120px; }
  .preview--audio audio { width: 90%; }
  .preview .glyph { padding: 48px 48px 20px; color: var(--text-tertiary); }
  .preview .glyph svg { display: block; }
  .preview__note { color: var(--text-secondary); font-size: 14px; padding: 0 24px 40px; text-align: center; max-width: 46ch; }

  /* ZIP-Inhaltsbaum */
  .zip { text-align: left; }
  .zip__head {
    padding: 14px 18px; font-weight: 600; font-size: 14px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .zip__tree { max-height: 60vh; overflow: auto; padding: 10px 18px 14px; font-size: 13.5px; }
  .zip__more { padding: 10px 18px 14px; color: var(--text-secondary); font-size: 12.5px; }
  .zt { list-style: none; margin: 0; padding-left: 18px; }
  .zip__tree > .zt { padding-left: 0; }
  .zt li { padding: 2px 0; }
  .zt summary {
    cursor: pointer; list-style: none; padding: 3px 6px; border-radius: 6px;
    display: flex; align-items: center; gap: 7px;
  }
  .zt summary::-webkit-details-marker { display: none; }
  .zt summary:hover { background: var(--accent-soft); }
  .zt svg { flex-shrink: 0; color: var(--text-tertiary); }
  .zt__file {
    display: flex; align-items: center; gap: 7px; padding: 3px 6px !important;
    border-radius: 6px; color: var(--text-primary);
  }
  .zt__file:hover { background: var(--accent-soft); }
  .zt__size, .zt__count {
    margin-left: auto; color: var(--text-tertiary); font-size: 12px;
    padding-left: 14px; white-space: nowrap; font-family: var(--font-mono);
  }

  /* PDF: eingebauter Viewer des Browsers */
  .pdf { width: 100%; height: 80vh; border: none; background: #fff; display: block; }

  /* Word/Dokument: hell, wie ein Blatt Papier */
  .doc {
    background: #ffffff; color: #1a1a1a; padding: 32px 40px;
    max-height: 80vh; overflow: auto; line-height: 1.55; font-size: 15px;
  }
  .doc :is(h1,h2,h3,h4) { line-height: 1.25; margin: 1.1em 0 .5em; }
  .doc p { margin: 0 0 .8em; }
  .doc table { border-collapse: collapse; margin: 1em 0; }
  .doc td, .doc th { border: 1px solid #ccc; padding: 5px 9px; }

  /* Tabelle (Excel/CSV) */
  .sheet { background: #ffffff; color: #1a1a1a; max-height: 80vh; overflow: auto; padding: 8px 8px 16px; }
  .sheet__name { font-weight: 600; padding: 12px 8px 6px; color: #333; }
  .sheet__more { padding: 10px 8px; color: #555; font-size: 13px; }
  .sheet table { border-collapse: collapse; font-size: 13px; width: max-content; font-family: var(--font-mono); }
  .sheet td, .sheet th { border: 1px solid #d0d0d0; padding: 4px 9px; white-space: nowrap; }
  .sheet tr:first-child td { background: #f3f5f9; font-weight: 600; }

  /* Text/Code */
  .text {
    margin: 0; background: #0e0f13; color: #d5d8e0; padding: 20px 22px;
    max-height: 80vh; overflow: auto; text-align: left;
    white-space: pre-wrap; word-break: break-word;
    font-family: var(--font-mono); font-size: 13px; line-height: 1.5;
  }

  .hint {
    display: flex; align-items: flex-start; gap: 8px; margin-top: 14px;
    color: var(--text-secondary); font-size: 13px; line-height: 1.5;
  }
  .hint svg { flex-shrink: 0; margin-top: 2px; }
  .warnbox {
    display: flex; gap: 10px; align-items: flex-start;
    margin: 0 0 14px; padding: 12px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5;
    background: var(--warning-bg); border: 1px solid color-mix(in srgb, var(--warning-fg) 45%, transparent);
    color: var(--warning-fg);
  }
  .warnbox svg { flex-shrink: 0; margin-top: 2px; }
  .warnbox strong { font-weight: 600; }
  .foot { color: var(--text-tertiary); font-size: 12.5px; margin-top: 28px; text-align: center; line-height: 1.8; }
  .foot__link { color: var(--text-tertiary); text-decoration: underline; text-underline-offset: 2px; }
  .foot__link:hover { color: var(--text-primary); }
  .empty { text-align: center; padding: 52px 24px; color: var(--text-secondary); line-height: 1.6; }
  .empty__title { margin: 0 0 6px; font-size: 18px; font-weight: 600; color: var(--text-primary); }
  .empty p { margin: 0 auto; max-width: 44ch; }

  /* ----- Sammlung: mehrere Dateien in einer Freigabe ----- */

  /* Zurück-Link über dem Titel (Einzelansicht innerhalb einer Sammlung) */
  .backlink {
    display: inline-block; margin-bottom: 14px; text-decoration: none;
    color: var(--text-secondary); font-size: 14px;
  }
  .backlink:hover { color: var(--accent-text); text-decoration: underline; }

  .files { list-style: none; margin: 0; padding: 0; }
  .files li + li { border-top: 1px solid var(--border-subtle); }
  .frow { display: flex; align-items: center; gap: 14px; padding: 12px 16px; }
  .frow__thumb {
    width: 56px; height: 56px; flex-shrink: 0; border-radius: 10px; overflow: hidden;
    display: grid; place-items: center;
    background: color-mix(in srgb, var(--tile-color, var(--kind-file)) 14%, var(--surface-card));
    color: var(--tile-color, var(--kind-file));
  }
  .frow__thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .frow--image { --tile-color: var(--kind-image); }
  .frow--video { --tile-color: var(--kind-video); }
  .frow--pdf   { --tile-color: var(--kind-pdf); }
  .frow--doc   { --tile-color: var(--kind-doc); }
  .frow--text  { --tile-color: var(--kind-text); }
  .frow--sheet { --tile-color: var(--kind-sheet); }
  .frow--zip   { --tile-color: var(--kind-zip); }
  .frow--audio { --tile-color: var(--kind-audio); }
  .frow__body { flex: 1 1 auto; min-width: 0; }
  .frow__name {
    color: var(--text-primary); text-decoration: none;
    font-size: 15px; font-weight: 500; word-break: break-word;
  }
  .frow__name:hover { color: var(--accent-text); text-decoration: underline; }
  .frow__meta { color: var(--text-secondary); font-size: 13px; margin-top: 3px; }
  .frow__dl {
    flex-shrink: 0; width: 44px; height: 44px; border-radius: 10px;
    display: grid; place-items: center; text-decoration: none;
    color: var(--text-secondary); background: var(--surface-card);
    border: 1px solid var(--border-control);
  }
  .frow__dl:hover { color: var(--accent-text); background: var(--accent-soft); border-color: var(--accent); }

  /* Kleine Bildschirme (Handy) */
  @media (max-width: 620px) {
    .topbar { padding: 0 16px; }
    .wrap { padding: 20px 16px 36px; }
    .card { border-radius: 12px; }
    .fname { font-size: 21px; }
    .head { align-items: stretch; flex-direction: column; }
    .head__actions .btn { flex: 1 1 auto; }
    .preview img, .preview video { max-height: 55vh; }
    .pdf { height: 70vh; }
    .doc { padding: 20px 18px; }
    .frow { gap: 11px; padding: 10px 12px; }
    .frow__thumb { width: 44px; height: 44px; }
    .frow__name { font-size: 14.5px; }
  }
`

const TOPBAR_HTML = `<header class="topbar">
  <div class="brand">${LOGO_SVG}<span class="brand__name">${escapeHtml(APP_NAME)}</span></div>
</header>`

/** Dateitypen, die beim Ausführen Schaden anrichten können: nur Hinweis, kein Block. */
const EXECUTABLE_EXTS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'scr', 'ps1', 'vbs', 'js', 'jar', 'com', 'pif', 'hta', 'wsf', 'reg', 'dll'
])

/** true, wenn die Endung des Namens als ausführbar gilt. */
function isExecutable(name: string): boolean {
  const ext = (String(name ?? '').split('.').pop() ?? '').toLowerCase()
  return EXECUTABLE_EXTS.has(ext)
}

/** Beschriftung der Art; Programme heißen so, auch wenn die Kachel „Datei“ zeigt. */
function kindLabel(name: string, kind: Kind): string {
  return isExecutable(name) ? 'Programm' : KIND_LABEL[kind]
}

/** Warnung vor Programmen, Wortlaut nach der Programm-Zwischenseite im Rechtstext. */
function warnBox(text: string): string {
  return `<div class="warnbox">${ICON_ALERT}<div>${text}</div></div>`
}
const TRUST_HINT =
  'Öffne sie nur, wenn du die Person kennst, die sie dir geschickt hat, und damit gerechnet hast.'

/** Datum der Freigabe, ohne Sekunden („4. November 2026, 00:19“). */
function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('de-DE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Texte der 404-Seiten (server.ts). */
export const GONE_TEXT =
  'Diesen Link gibt es nicht oder nicht mehr. Vielleicht wurde die Freigabe gelöscht. Frag am besten bei der Person nach, die ihn dir geschickt hat.'
export const EXPIRED_TEXT =
  'Dieser Link ist abgelaufen. Frag die Person, die ihn dir geschickt hat, nach einem neuen.'

/** Ohne Angabe: LAN/Domain-Familie ohne Freigabe (Startseite, 404 auf /s/…). */
const NO_SHARE: Pick<ShareLinks, 'family' | 'fontBase' | 'token'> = { family: 'lan', fontBase: '/_font' }

/**
 * Fußzeile je Pfadfamilie, Wortlaut nach privat/recht (Abschnitt 4). Über den
 * Relay: Über foldwing.online, Melden, Impressum, Datenschutz (relative Pfade,
 * der Relay bedient bzw. leitet `/_/…` weiter); im eigenen Netz und auf der
 * eigenen Domain steht nur der Name.
 */
function footer(links: Pick<ShareLinks, 'family' | 'token'>): string {
  const name = escapeHtml(APP_NAME)
  if (links.family === 'relay' && links.token) {
    const t = escapeHtml(links.token.replace(/[^A-Za-z0-9]/g, ''))
    return `<div class="foot">Geteilt mit ${name} · <a class="foot__link" href="/_/">Über foldwing.online</a> · <a class="foot__link" href="/_/melden?l=${t}">Melden</a> · <a class="foot__link" href="/_/impressum">Impressum</a> · <a class="foot__link" href="/_/datenschutz">Datenschutz</a></div>`
  }
  return `<div class="foot">Geteilt mit ${name}</div>`
}

/** Gemeinsamer Seitenrahmen. */
function layout(title: string, links: Pick<ShareLinks, 'fontBase'>, body: string): string {
  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${fontCss(links.fontBase)}${BASE_CSS}</style>
</head><body>
  ${TOPBAR_HTML}
  <main class="wrap">
    ${body}
  </main>
</body></html>`
}

/**
 * Freigabe-Seite einer einzelnen Datei.
 * Ohne `opts.file` die klassische Einzeldatei-Freigabe; mit `opts.file` eine Datei
 * aus einer Sammlung (Titel/Meta/Warnung kommen dann aus der Teildatei, die Links
 * zeigen auf deren Rohdaten, und ein Zurück-Link führt zur Übersicht).
 */
export function sharePage(
  meta: ShareMeta,
  preview: string,
  links: ShareLinks,
  opts?: { file?: ShareFile }
): string {
  const part = opts?.file
  const rawName = part ? part.name : meta.name
  const name = escapeHtml(rawName)
  const fileUrl = escapeHtml(part ? links.raw(part.fid) : links.raw())
  const size = part ? part.size : meta.size
  const mime = part ? part.mime : meta.mime
  const execWarning = isExecutable(rawName)
    ? warnBox(`<strong>Diese Datei ist ausführbar, also ein Programm.</strong> ${TRUST_HINT}`)
    : ''
  const back = part
    ? `<a class="backlink" href="${escapeHtml(links.page())}">← Zurück zu allen Dateien</a>`
    : ''

  return layout(
    `${name} · ${escapeHtml(APP_NAME)}`,
    links,
    `${back}
    <div class="head">
      <div>
        <div class="eyebrow">Für dich geteilt</div>
        <h1 class="fname">${name}</h1>
        <div class="meta">${formatBytes(size)} · ${kindLabel(rawName, detectKind(rawName, mime))} · ${formatDate(
          meta.createdAt
        )}</div>
      </div>
      <div class="head__actions">
        <a class="btn btn--primary" href="${fileUrl}?dl=1" download>${ICON_DOWNLOAD} Herunterladen</a>
        <a class="btn" href="${fileUrl}" target="_blank">In neuem Tab öffnen</a>
      </div>
    </div>
    ${execWarning}
    <div class="card">${preview}</div>
    <div class="hint">${ICON_EYE}<span>Das ist eine Vorschau. Beim Herunterladen bekommst du die Originaldatei, unverändert und in voller Qualität.</span></div>
    ${footer(links)}`
  )
}

/** Eine Zeile der Dateiliste: Kachel/Thumbnail, Name + Größe/Art, Download-Knopf. */
function bundleRow(links: ShareLinks, file: ShareFile): string {
  const name = escapeHtml(file.name)
  const kind = detectKind(file.name, file.mime)
  const fileUrl = escapeHtml(links.raw(file.fid))
  // Bilder zeigen sich selbst; alles andere bekommt eine farbige Icon-Kachel.
  // Video/Audio bewusst NICHT einbetten, sonst zöge das Öffnen der Seite jede
  // Datei der Sammlung an.
  const thumb =
    kind === 'image'
      ? `<img src="${fileUrl}" alt="" loading="lazy" decoding="async">`
      : lineIcon(KIND_SHAPES[kind], 24)
  return `<li>
        <div class="frow frow--${kind}">
          <span class="frow__thumb">${thumb}</span>
          <div class="frow__body">
            <a class="frow__name" href="${escapeHtml(links.page(file.fid))}">${name}</a>
            <div class="frow__meta">${formatBytes(file.size)} · ${kindLabel(file.name, kind)}</div>
          </div>
          <a class="frow__dl" href="${fileUrl}?dl=1" download title="${name} herunterladen" aria-label="${name} herunterladen">${ICON_DOWNLOAD}</a>
        </div>
      </li>`
}

/** Übersicht einer Sammlung: ein Link, mehrere Dateien. */
export function bundlePage(meta: ShareMeta, links: ShareLinks): string {
  const files = Array.isArray(meta.files) ? meta.files : []
  const title = escapeHtml(meta.name)
  const total = files.length ? files.reduce((sum, f) => sum + (f.size || 0), 0) : meta.size

  const risky = files.filter((f) => isExecutable(f.name)).map((f) => escapeHtml(f.name))
  const execWarning = risky.length
    ? warnBox(
        `<strong>${
          risky.length === 1 ? 'Eine Datei ist ausführbar' : `${risky.length} Dateien sind ausführbar`
        }: ${risky.join(', ')}.</strong> ${TRUST_HINT}`
      )
    : ''

  const rows = files.map((f) => bundleRow(links, f)).join('\n      ')
  const list = rows
    ? `<ul class="files">
      ${rows}
    </ul>`
    : `<div class="empty"><p>In dieser Freigabe liegen keine Dateien mehr.</p></div>`

  return layout(
    `${title} · ${escapeHtml(APP_NAME)}`,
    links,
    `<div class="head">
      <div>
        <div class="eyebrow">Für dich geteilt</div>
        <h1 class="fname">${title}</h1>
        <div class="meta">${formatBytes(total)} · ${formatDate(meta.createdAt)}</div>
      </div>
      <div class="head__actions">
        <a class="btn btn--primary" href="${escapeHtml(links.raw())}?dl=1" download>${ICON_DOWNLOAD} Alle als ZIP herunterladen</a>
      </div>
    </div>
    ${execWarning}
    <div class="card">${list}</div>
    <div class="hint">${ICON_EYE}<span>Klick auf einen Namen für die Vorschau. Heruntergeladen wird immer das Original, unverändert und in voller Qualität.</span></div>
    ${footer(links)}`
  )
}

/**
 * Startseite und Hinweisseiten („gibt es nicht mehr“). `links` bestimmt die
 * Pfadfamilie für Schriften und Fußzeile: über den Relay abgerufene 404-Seiten
 * müssen auch dort ihre Schriften finden.
 */
export function landingPage(
  message?: string,
  links: Pick<ShareLinks, 'family' | 'fontBase' | 'token'> = NO_SHARE
): string {
  const body = message
    ? `<div class="empty"><p>${escapeHtml(message)}</p></div>`
    : `<div class="empty"><p class="empty__title">Hier gibt's nichts zu sehen.</p><p>Öffne den Link, den du bekommen hast. Er führt direkt zur geteilten Datei.</p></div>`
  return layout(escapeHtml(APP_NAME), links, `<div class="card">${body}</div>
    ${footer(links)}`)
}
