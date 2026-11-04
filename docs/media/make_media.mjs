/**
 * README-Medien für Foldwing – reproduzierbar aus der echten App, mit erfundenen Daten.
 *
 * Was entsteht (alles in docs/media/):
 *   hero.gif            Dateien ablegen → Sammel-Link → Seite des Empfängers → Tabellen-Vorschau
 *   app.png             Hauptfenster (hell) mit mehreren Freigaben
 *   share-page.png      Empfänger-Seite einer Sammlung (hell)
 *   file-preview.png    Empfänger-Ansicht einer Tabelle (dunkel)
 *   social-preview.png  Vorschaubild für GitHub (1280×640)
 *   logo.svg            App-Logo, aus scripts/make-icon.mjs übernommen
 *
 * Wie: Electron lädt die GEBAUTE Oberfläche (out/renderer) mit der echten Preload-
 * Brücke (out/preload, window.foldwing). Nur der Hauptprozess ist eine Attrappe: Er
 * beantwortet die IPC-Aufrufe der Oberfläche, meldet die Links als „über foldwing.online
 * erreichbar“ und legt Uploads in einer echten ShareStore-Ablage im Temp-Ordner ab. Die
 * Seiten des Empfängers liefert der echte Server (src/main/server.ts, per esbuild
 * gebündelt) auf 127.0.0.1, über die Relay-Pfade (/<Geräte-ID><Freigabe-ID>) mit einer
 * erfundenen Geräte-ID. Ein Relay, ein Tunnel oder Cloudflare sind nicht beteiligt; die
 * Browser-Leiste im Bild zeigt nur die Adresse, unter der Empfänger die Seite öffnen.
 * Gerendert wird unsichtbar (Offscreen-Fenster) in doppelter Auflösung; ffmpeg setzt
 * die Einzelbilder zum GIF zusammen.
 *
 * Aufruf aus dem Projektordner:
 *   npm run build && npm run media
 *   npm run media -- --keep        Temp-Ordner (Einzelbilder, Ablage) danach behalten
 *   npm run media -- --port 8017   Server auf diesem Port statt einem vom System gewählten
 *   npm run media -- --site <dir>  zusätzlich Bilder für eine Projektseite außerhalb des
 *                                  Repos: background.webp (1920×1200), ein kurzer Loop
 *                                  (webm/mp4, 1280×800) und Standbilder (1600 px, WebP)
 * ffmpeg kommt aus dem PATH oder aus der Umgebungsvariable FFMPEG.
 *
 * Sicherheit – alles hier landet in einem öffentlichen Repository:
 *  * Vor allem anderen zeigen APPDATA, LOCALAPPDATA, USERPROFILE, HOME, XDG_* und TEMP
 *    auf einen frischen Temp-Ordner, der Kontoname ist „alex“. Electron legt dort auch
 *    userData, Logs und Absturzberichte ab; liegt ein Datenpfad außerhalb, bricht das
 *    Skript ab. Der echte Hauptprozess (index.ts, config.ts) läuft gar nicht – echte
 *    Einstellungen samt Geräte-ID und Relay-Geheimnis sowie der Foldwing-Ordner in APPDATA
 *    bleiben ungelesen.
 *  * Kein Fenster erscheint auf dem Bildschirm. Netzwerk nach außen ist gesperrt
 *    (erlaubt ist nur 127.0.0.1:<eigener Port>), die Zwischenablage bleibt unberührt,
 *    nichts öffnet sich im Systembrowser, kein Virenscanner wird angestoßen.
 *  * Uhr und Zufall der gebündelten Ablage sind Attrappen: Zeitstempel und
 *    Freigabe-IDs sind fest, jeder Neubau liefert dieselben Bilder.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// Unter Node der Pfad zur Electron-Programmdatei, unter Electron die API selbst.
import electron from 'electron'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const USER = 'alex'
/** Standard-Relay der App; Links sehen im Bild so aus wie bei jedem Nutzer. */
const RELAY_URL = 'https://foldwing.online'
/** Erfundene Geräte-ID (8 Zeichen base62). Ein echtes Gerät hat eine zufällige. */
const DEVICE_ID = 'Rk4mT7qa'
const shareUrl = (id) => `${RELAY_URL}/${DEVICE_ID}${id}`
/** Pfad der Freigabe-Seite auf dem eigenen Server (Relay-Pfadfamilie, src/main/links.ts). */
const sharePath = (id, fid) => (fid ? `/${DEVICE_ID}${id}/${fid}` : `/${DEVICE_ID}${id}`)
const SCALE = 2 // alles in doppelter Auflösung; die README zeigt halbe Breite
const FPS = 20

/** Erfundene Uhrzeiten (Europe/Berlin). Die gebündelte Ablage läuft mit dieser Uhr. */
const CLOCK = {
  screenshot: Date.parse('2026-10-14T09:12:48+02:00'),
  notes: Date.parse('2026-10-14T09:27:05+02:00'),
  upload: Date.parse('2026-10-14T09:41:20+02:00')
}

/** Die Beispieldateien. Inhalte erzeugt makeSamples() – nichts davon ist echt. */
const FILES = {
  moodboard: { name: 'Moodboard.png', mime: 'image/png' },
  plan: { name: 'Grundriss.png', mime: 'image/png' },
  sheet: {
    name: 'Quartalszahlen.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  },
  notes: { name: 'Notizen.txt', mime: 'text/plain' },
  screenshot: { name: 'Screenshot 2026-10-14 09-12-48.png', mime: 'image/png' }
}
/** Diese drei landen im GIF per Drag & Drop als EINE Sammlung. */
const BUNDLE = [FILES.moodboard, FILES.plan, FILES.sheet]

const log = (msg) => console.log(`[media] ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Der Einstieg steht ganz unten in der Datei (nach allen Konstanten).

// =====================================================================================
// Teil 1 (Node): Sandbox, Beispieldateien, Server-Bündel, Electron starten, GIF bauen
// =====================================================================================

/** Wert hinter einer Option (`--port 8017`), sonst null. */
function argValue(name) {
  const i = process.argv.indexOf(name)
  if (i < 0) return null
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) throw new Error(`${name} braucht einen Wert.`)
  return v
}

async function launch() {
  const keep = process.argv.includes('--keep')
  const port = argValue('--port')
  if (port !== null && !/^\d{1,5}$/.test(port)) throw new Error('--port: nur eine Portnummer.')
  // Zielordner für die Projektseite: absolut auflösen, BEVOR HOME & Co. umgebogen werden.
  const siteArg = argValue('--site')
  const site = siteArg ? path.resolve(siteArg) : null
  // Sandbox ZUERST – bevor irgendetwas anderes passiert.
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foldwing-media-')))
  enterSandbox(sandbox)
  process.env.FOLDWING_MEDIA_PORT = port ?? '0'
  if (site) process.env.FOLDWING_MEDIA_SITE = '1'
  const work = (...p) => path.join(sandbox, ...p)
  let ok = false
  try {
    checkBuild()
    const ffmpeg = findTool('ffmpeg', 'FFMPEG')

    log('Beispieldateien erzeugen …')
    await makeSamples(work('samples'))
    log('Server und Ablage bündeln …')
    await bundleServer(work('server.mjs'))

    log('Electron rendert (unsichtbar) …')
    const r = spawnSync(electron, [fileURLToPath(import.meta.url)], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      timeout: 5 * 60_000
    })
    if (r.status !== 0) {
      throw new Error(`Electron-Teil fehlgeschlagen (Exit ${r.status ?? r.signal ?? r.error})`)
    }

    log('GIF zusammensetzen …')
    makeGif(ffmpeg, work('frames'), path.join(HERE, 'hero.gif'))
    for (const name of ['app.png', 'share-page.png', 'file-preview.png', 'social-preview.png']) {
      savePng(ffmpeg, work('out', name), path.join(HERE, name))
    }
    writeLogo()
    report()
    if (site) {
      log('Bilder für die Projektseite …')
      makeSiteMedia(ffmpeg, work, site)
    }
    ok = true
  } finally {
    if (keep) log(`Temp-Ordner bleibt liegen: ${sandbox}`)
    else removeDir(sandbox)
  }
  if (!ok) process.exitCode = 1
}

/** Alle Pfade, unter denen Programme Nutzerdaten suchen, in die Sandbox biegen. */
function enterSandbox(sandbox) {
  const env = process.env
  const home = path.join(sandbox, 'home', USER)
  const dir = (key, value) => {
    fs.mkdirSync(value, { recursive: true })
    env[key] = value
  }
  dir('HOME', home)
  dir('USERPROFILE', home)
  dir('APPDATA', path.join(home, 'appdata-roaming'))
  dir('LOCALAPPDATA', path.join(home, 'appdata-local'))
  dir('XDG_CONFIG_HOME', path.join(home, '.config'))
  dir('XDG_DATA_HOME', path.join(home, '.local', 'share'))
  dir('XDG_CACHE_HOME', path.join(home, '.cache'))
  dir('XDG_STATE_HOME', path.join(home, '.local', 'state'))
  dir('TEMP', path.join(sandbox, 'tmp'))
  env.TMP = env.TEMP
  env.TMPDIR = env.TEMP
  if (process.platform === 'win32') {
    env.HOMEDRIVE = path.parse(home).root.replace(/[\\/]+$/, '')
    env.HOMEPATH = home.slice(env.HOMEDRIVE.length)
  }
  // getpass & Co. lesen diese Variablen; os.userInfo() ersetzt Teil 2 zusätzlich.
  for (const key of ['LOGNAME', 'USER', 'LNAME', 'USERNAME']) env[key] = USER
  env.TZ = 'Europe/Berlin'
  env.LANG = 'de_DE.UTF-8'
  env.FOLDWING_MEDIA_SANDBOX = sandbox
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  // Nur für die Entwicklung gedacht; die Bilder zeigen immer den Standard-Relay.
  delete env.FOLDWING_RELAY_URL
}

/** Gebaute Oberfläche vorhanden und nicht älter als ihre Quellen? */
function checkBuild() {
  const built = ['out/renderer/index.html', 'out/preload/index.mjs'].map((p) => path.join(ROOT, p))
  for (const f of built) {
    if (!fs.existsSync(f)) throw new Error(`${rel(f)} fehlt – zuerst „npm run build“ ausführen.`)
  }
  const buildTime = Math.min(...built.map((f) => fs.statSync(f).mtimeMs))
  const stack = [path.join(ROOT, 'src', 'renderer'), path.join(ROOT, 'src', 'preload')]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (fs.statSync(full).mtimeMs > buildTime) {
        throw new Error(`${rel(full)} ist neuer als der Build – zuerst „npm run build“ ausführen.`)
      }
    }
  }
}

function findTool(name, envVar) {
  const fromEnv = process.env[envVar]
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) return fromEnv
    throw new Error(`${envVar} zeigt auf eine Datei, die es nicht gibt.`)
  }
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
  }
  throw new Error(`${name} nicht gefunden – in den PATH legen oder ${envVar} setzen.`)
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] })
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} fehlgeschlagen (Exit ${r.status})`)
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch {
    log(`Hinweis: Temp-Ordner blieb liegen: ${dir}`)
  }
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

// ---- Beispieldateien ----------------------------------------------------------------

async function makeSamples(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const { Resvg } = await import('@resvg/resvg-js')
  // Keine Systemschriften: Die Bilder enthalten keinen Text und sehen überall gleich aus.
  const png = (svg) =>
    new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } })
      .render()
      .asPng()
  fs.writeFileSync(path.join(dir, FILES.moodboard.name), png(moodboardSvg()))
  fs.writeFileSync(path.join(dir, FILES.plan.name), png(planSvg()))
  fs.writeFileSync(path.join(dir, FILES.screenshot.name), png(screenshotSvg()))
  fs.writeFileSync(path.join(dir, FILES.notes.name), NOTES)
  fs.writeFileSync(path.join(dir, FILES.sheet.name), await quarterlySheet())
}

const NOTES = `Projekt Seeblick – Notizen

- Moodboard und Grundriss an Kim schicken
- Fenster im Bad nachmessen
- Quartalszahlen bis Freitag prüfen
`

/** Quartalszahlen.xlsx: ein Blatt, Werte in Tausend Euro (erfunden). */
async function quarterlySheet() {
  const { default: XLSX } = await import('xlsx')
  const rows = [
    ['Quartal', 'Umsatz (Tsd. €)', 'Kosten (Tsd. €)', 'Ergebnis (Tsd. €)', 'Kunden', 'Wachstum'],
    ['Q1', 482, 391, 91, 1240, 0.04],
    ['Q2', 517, 402, 115, 1318, 0.07],
    ['Q3', 563, 419, 144, 1405, 0.09],
    ['Q4 (Plan)', 601, 436, 165, 1490, 0.07],
    ['Summe', 2163, 1648, 515, '', '']
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  for (let r = 2; r <= 5; r++) {
    ws[`D${r}`].f = `B${r}-C${r}`
    ws[`F${r}`].z = '0%'
  }
  for (const c of ['B', 'C', 'D']) ws[`${c}6`].f = `SUM(${c}2:${c}5)`
  ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 17 }, { wch: 9 }, { wch: 10 }]
  const wb = XLSX.utils.book_new()
  wb.Props = { Title: 'Quartalszahlen 2026', Author: 'Alex', CreatedDate: new Date(CLOCK.notes) }
  XLSX.utils.book_append_sheet(wb, ws, '2026')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true })
}

function moodboardSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fcdcbc"/><stop offset="0.58" stop-color="#f29f88"/><stop offset="1" stop-color="#b8769c"/>
    </linearGradient>
    <linearGradient id="hillA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c7b7c"/><stop offset="1" stop-color="#335a61"/></linearGradient>
    <linearGradient id="hillB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#284750"/><stop offset="1" stop-color="#1b323a"/></linearGradient>
    <clipPath id="landscape"><rect x="48" y="48" width="760" height="904" rx="28"/></clipPath>
    <clipPath id="arch"><rect x="840" y="512" width="340" height="440" rx="28"/></clipPath>
    <clipPath id="waves"><rect x="1212" y="512" width="340" height="440" rx="28"/></clipPath>
  </defs>
  <rect width="1600" height="1000" fill="#f2ede6"/>
  <g clip-path="url(#landscape)">
    <rect x="48" y="48" width="760" height="904" fill="url(#sky)"/>
    <circle cx="540" cy="440" r="118" fill="#fff1d6"/>
    <path d="M48 640 C 210 560 380 600 520 652 S 740 610 808 624 L808 952 L48 952 Z" fill="url(#hillA)"/>
    <path d="M48 772 C 210 706 420 772 600 748 S 770 724 808 736 L808 952 L48 952 Z" fill="url(#hillB)"/>
    <path d="M176 300 q 16 -14 32 0 q 16 -14 32 0" fill="none" stroke="#7d4f6b" stroke-width="6" stroke-linecap="round"/>
    <path d="M262 352 q 12 -10 24 0 q 12 -10 24 0" fill="none" stroke="#7d4f6b" stroke-width="5" stroke-linecap="round"/>
  </g>
  <rect x="840" y="48" width="340" height="432" rx="28" fill="#ffffff"/>
  <circle cx="930" cy="150" r="58" fill="#e07a5f"/>
  <circle cx="1090" cy="150" r="58" fill="#f2cc8f"/>
  <circle cx="930" cy="330" r="58" fill="#81b29a"/>
  <circle cx="1090" cy="330" r="58" fill="#3d405b"/>
  <rect x="898" y="226" width="64" height="12" rx="6" fill="#ddd5ca"/>
  <rect x="1058" y="226" width="64" height="12" rx="6" fill="#ddd5ca"/>
  <rect x="898" y="406" width="64" height="12" rx="6" fill="#ddd5ca"/>
  <rect x="1058" y="406" width="64" height="12" rx="6" fill="#ddd5ca"/>
  <rect x="1212" y="48" width="340" height="432" rx="28" fill="#d3e3d5"/>
  <g transform="translate(1382 268) rotate(-28)">
    <path d="M0 -170 C 92 -110 92 110 0 170 C -92 110 -92 -110 0 -170 Z" fill="#5f8f6b"/>
    <path d="M0 -150 L0 160" stroke="#3f6b4b" stroke-width="6" stroke-linecap="round"/>
    <path d="M0 -70 L44 -112 M0 -10 L52 -52 M0 50 L48 10 M0 -70 L-44 -112 M0 -10 L-52 -52 M0 50 L-48 10" stroke="#3f6b4b" stroke-width="5" stroke-linecap="round"/>
  </g>
  <g clip-path="url(#arch)">
    <rect x="840" y="512" width="340" height="440" fill="#f6e2c8"/>
    <path d="M900 952 L900 720 A110 110 0 0 1 1120 720 L1120 952 Z" fill="#e07a5f"/>
    <path d="M948 952 L948 736 A62 62 0 0 1 1072 736 L1072 952 Z" fill="#f0a487"/>
    <rect x="840" y="900" width="340" height="52" fill="#d9b48e"/>
  </g>
  <g clip-path="url(#waves)">
    <rect x="1212" y="512" width="340" height="440" fill="#3d405b"/>
    <g fill="none" stroke="#f2cc8f" stroke-width="12" stroke-linecap="round">
      <path d="M1180 610 q 42 -36 84 0 t 84 0 t 84 0 t 84 0 t 84 0"/>
      <path d="M1180 690 q 42 -36 84 0 t 84 0 t 84 0 t 84 0 t 84 0"/>
      <path d="M1180 770 q 42 -36 84 0 t 84 0 t 84 0 t 84 0 t 84 0"/>
      <path d="M1180 850 q 42 -36 84 0 t 84 0 t 84 0 t 84 0 t 84 0"/>
    </g>
  </g>
</svg>`
}

function planSvg() {
  const wall = 'stroke="#2b2f36" stroke-width="16" stroke-linecap="square" fill="none"'
  const inner = 'stroke="#2b2f36" stroke-width="9" stroke-linecap="square" fill="none"'
  const furn = 'stroke="#97a3b3" stroke-width="3.5" fill="#ffffff" stroke-linejoin="round"'
  const door = 'stroke="#8a94a3" stroke-width="2.5" fill="none" stroke-dasharray="6 6"'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1100" viewBox="0 0 1600 1100">
  <defs>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="#e7edf4" stroke-width="2"/>
    </pattern>
  </defs>
  <rect width="1600" height="1100" fill="#fbfbf9"/>
  <rect width="1600" height="1100" fill="url(#grid)"/>
  <rect x="160" y="160" width="640" height="400" fill="#edf2fa"/>
  <rect x="800" y="160" width="640" height="400" fill="#f6f1e7"/>
  <rect x="160" y="560" width="600" height="380" fill="#f4eef6"/>
  <rect x="760" y="560" width="360" height="380" fill="#fbfbf9"/>
  <rect x="1120" y="560" width="320" height="380" fill="#e9f4f3"/>
  <path d="M160 160 H1440 V940 H160 Z" ${wall}/>
  <path d="M800 160 V300 M800 420 V560" ${inner}/>
  <path d="M160 560 H300 M420 560 H880 M1000 560 H1440" ${inner}/>
  <path d="M760 560 V700 M760 820 V940" ${inner}/>
  <path d="M1120 560 V780 M1120 900 V940" ${inner}/>
  <path d="M300 560 A120 120 0 0 1 420 440" ${door}/><path d="M420 560 V440" stroke="#8a94a3" stroke-width="3"/>
  <path d="M880 560 A120 120 0 0 0 1000 680" ${door}/><path d="M1000 560 V680" stroke="#8a94a3" stroke-width="3"/>
  <path d="M760 700 A120 120 0 0 1 880 820" ${door}/><path d="M760 820 H880" stroke="#8a94a3" stroke-width="3"/>
  <path d="M1120 780 A120 120 0 0 0 1000 900" ${door}/><path d="M1120 900 H1000" stroke="#8a94a3" stroke-width="3"/>
  <path d="M800 300 A120 120 0 0 1 680 420" ${door}/><path d="M800 420 H680" stroke="#8a94a3" stroke-width="3"/>
  <g fill="#ffffff" stroke="#8fb9de" stroke-width="4">
    <rect x="260" y="152" width="220" height="16"/><rect x="1000" y="152" width="200" height="16"/>
    <rect x="152" y="660" width="16" height="180"/><rect x="1432" y="640" width="16" height="140"/>
    <rect x="1432" y="260" width="16" height="180"/>
  </g>
  <rect x="220" y="400" width="340" height="110" rx="18" ${furn}/>
  <path d="M220 440 H560 M333 440 V510 M446 440 V510" stroke="#97a3b3" stroke-width="3"/>
  <rect x="300" y="250" width="180" height="90" rx="10" ${furn}/>
  <rect x="610" y="230" width="110" height="110" rx="20" ${furn}/>
  <rect x="820" y="180" width="600" height="72" ${furn}/>
  <circle cx="930" cy="216" r="22" ${furn}/>
  <circle cx="1210" cy="204" r="12" ${furn}/><circle cx="1250" cy="204" r="12" ${furn}/>
  <circle cx="1210" cy="232" r="12" ${furn}/><circle cx="1250" cy="232" r="12" ${furn}/>
  <circle cx="1130" cy="410" r="78" ${furn}/>
  <rect x="1106" y="300" width="48" height="26" rx="8" ${furn}/><rect x="1106" y="494" width="48" height="26" rx="8" ${furn}/>
  <rect x="1020" y="386" width="26" height="48" rx="8" ${furn}/><rect x="1214" y="386" width="26" height="48" rx="8" ${furn}/>
  <rect x="300" y="600" width="270" height="310" rx="12" ${furn}/>
  <rect x="320" y="616" width="105" height="62" rx="14" ${furn}/><rect x="445" y="616" width="105" height="62" rx="14" ${furn}/>
  <path d="M300 720 H570" stroke="#97a3b3" stroke-width="3"/>
  <rect x="176" y="600" width="64" height="300" ${furn}/>
  <rect x="1290" y="620" width="130" height="280" rx="40" ${furn}/>
  <ellipse cx="1190" cy="880" rx="34" ry="44" ${furn}/>
  <rect x="1150" y="600" width="110" height="64" rx="14" ${furn}/>
  <g stroke="#b8c1cc" stroke-width="3" fill="none">
    <path d="M160 100 H1440 M160 84 V116 M800 84 V116 M1440 84 V116"/>
    <path d="M1500 160 V940 M1484 160 H1516 M1484 560 H1516 M1484 940 H1516"/>
  </g>
  <g transform="translate(1500 1020)">
    <circle r="34" fill="#ffffff" stroke="#b8c1cc" stroke-width="3"/>
    <path d="M0 -24 L12 12 L0 4 L-12 12 Z" fill="#5c6b7c"/>
  </g>
</svg>`
}

function screenshotSvg() {
  const bars = [210, 300, 260, 380, 330, 450, 410]
    .map((h, i) => `<rect x="${170 + i * 140}" y="${640 - h}" width="84" height="${h}" rx="10" fill="#5c86f8"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#eef1f4"/>
  <rect x="80" y="60" width="1120" height="620" rx="18" fill="#ffffff"/>
  <rect x="120" y="100" width="300" height="22" rx="11" fill="#c2cad4"/>
  <rect x="120" y="136" width="180" height="16" rx="8" fill="#e5e9ee"/>
  <path d="M150 640 H1150" stroke="#d8dee6" stroke-width="3"/>
  ${bars}
</svg>`
}

// ---- Server-Bündel --------------------------------------------------------------

/**
 * src/main/server.ts + store.ts für Electron bündeln – mit drei Nähten nur für die
 * Medien: Uhr (`Date.now`) und Zufall der Ablage sind Attrappen (feste Zeitstempel
 * und IDs), und die Schriften kommen aus resources/fonts statt aus einem Paket.
 * xlsx/mammoth bleiben extern und werden aus node_modules des Projekts geladen.
 */
async function bundleServer(outfile) {
  const { build } = await import('esbuild')
  const requireFromRoot = createRequire(path.join(ROOT, 'package.json'))
  await build({
    stdin: {
      contents: "export { ShareStore } from './src/main/store'\nexport { startServer } from './src/main/server'\n",
      resolveDir: ROOT,
      sourcefile: 'media-entry.ts',
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    define: {
      // Ohne resourcesPath sucht server.ts die Schriften unter <cwd>/resources/fonts.
      'process.resourcesPath': 'undefined',
      'Date.now': 'globalThis.__foldwingMediaNow'
    },
    plugins: [
      {
        name: 'foldwing-media',
        setup(b) {
          b.onResolve({ filter: /^(xlsx|mammoth)$/ }, (a) => ({
            path: pathToFileURL(requireFromRoot.resolve(a.path)).href,
            external: true
          }))
          b.onResolve({ filter: /^(node:)?crypto$/ }, (a) =>
            /[\\/]src[\\/]main[\\/]store\.ts$/.test(a.importer)
              ? { path: 'seeded-crypto', namespace: 'foldwing-media' }
              : undefined
          )
          b.onLoad({ filter: /.*/, namespace: 'foldwing-media' }, () => ({
            contents: SEEDED_CRYPTO,
            loader: 'js'
          }))
        }
      }
    ]
  })
}

/** Zufall mit festem Startwert (mulberry32) – nur für die IDs der Medien-Ablage. */
const SEEDED_CRYPTO = `
let state = 0x46534d31
export function randomBytes(n) {
  const out = Buffer.alloc(n)
  for (let i = 0; i < n; i++) {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff
  }
  return out
}
`

// ---- Nacharbeit: GIF, PNG, Logo, Bericht ------------------------------------------

function makeGif(ffmpeg, framesDir, target) {
  const vf =
    'split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];' +
    '[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle'
  run(ffmpeg, ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(framesDir, 'f_%05d.png'),
    '-vf', vf, '-loop', '0', target])
}

/** PNG ohne Alphakanal und ohne Metadaten neu schreiben (deckend, klein). */
function savePng(ffmpeg, source, target) {
  run(ffmpeg, ['-v', 'error', '-y', '-i', source, '-pix_fmt', 'rgb24', '-pred', 'mixed',
    '-compression_level', '9', '-frames:v', '1', target])
}

/** Grundfarbe der Projektseiten-Bilder: das Dunkelblau aus dem Kiel des Logos, abgedunkelt. */
const SITE_BG = '0x0d1a3a'

/**
 * Bilder für eine Projektseite (--site): Hintergrund, ein Loop aus den Bildern des GIFs
 * und drei Standbilder. Alles mit derselben Grundfarbe, damit die Bilder in einem
 * farbigen Rahmen ruhig wirken.
 */
function makeSiteMedia(ffmpeg, work, dir) {
  const media = path.join(dir, 'media')
  fs.mkdirSync(media, { recursive: true })
  const out = (...p) => path.join(dir, ...p)

  run(ffmpeg, ['-v', 'error', '-y', '-i', work('out', 'site-background.png'),
    '-c:v', 'libwebp', '-quality', '82', '-compression_level', '6', out('background.webp')])

  // Loop 1280×800: das GIF-Bild (760×640) mittig, links und rechts die Grundfarbe.
  const frames = path.join(work('frames'), 'f_%05d.png')
  const fit = `scale=-2:800:flags=lanczos,pad=1280:800:(ow-iw)/2:0:color=${SITE_BG},format=yuv420p`
  run(ffmpeg, ['-v', 'error', '-y', '-framerate', String(FPS), '-i', frames, '-vf', fit,
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', '-an', media + '/teilen.webm'])
  run(ffmpeg, ['-v', 'error', '-y', '-framerate', String(FPS), '-i', frames, '-vf', fit,
    '-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-movflags', '+faststart', '-an', media + '/teilen.mp4'])
  run(ffmpeg, ['-v', 'error', '-y', '-i', path.join(work('frames'), 'f_00000.png'),
    '-vf', 'scale=-2:800:flags=lanczos,pad=1280:800:(ow-iw)/2:0:color=' + SITE_BG,
    '-c:v', 'libwebp', '-quality', '86', media + '/teilen-poster.webp'])

  // Standbilder 1600×1000 (16:10): Bild eingepasst, ringsum Luft in der Grundfarbe.
  const still = (source, target) =>
    run(ffmpeg, ['-v', 'error', '-y', '-i', work('out', source), '-vf',
      `scale=1480:920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1600:1000:(ow-iw)/2:(oh-ih)/2:color=${SITE_BG}`,
      '-c:v', 'libwebp', '-quality', '86', '-compression_level', '6', path.join(media, target)])
  still('app.png', 'app.webp')
  still('share-page.png', 'empfaenger-sammlung.webp')
  still('file-preview.png', 'empfaenger-tabelle.webp')

  for (const rel of ['background.webp', 'media/teilen.webm', 'media/teilen.mp4', 'media/teilen-poster.webp',
    'media/app.webp', 'media/empfaenger-sammlung.webp', 'media/empfaenger-tabelle.webp']) {
    log(`${rel}: ${Math.round(fs.statSync(out(rel)).size / 1024)} KB`)
  }
}

/** Das Logo ist das SVG aus scripts/make-icon.mjs – eine Quelle für App-Icon und README. */
function writeLogo() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'make-icon.mjs'), 'utf8')
  const m = src.match(/const SVG = `(<svg[\s\S]*?<\/svg>)`/)
  if (!m) throw new Error('SVG in scripts/make-icon.mjs nicht gefunden.')
  fs.writeFileSync(path.join(HERE, 'logo.svg'), m[1].replace(/\r\n/g, '\n') + '\n')
}

function report() {
  for (const name of ['hero.gif', 'app.png', 'share-page.png', 'file-preview.png', 'social-preview.png', 'logo.svg']) {
    const file = path.join(HERE, name)
    const buf = fs.readFileSync(file)
    let dims = ''
    if (name.endsWith('.png')) dims = `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`
    if (name.endsWith('.gif')) dims = `${buf.readUInt16LE(6)}×${buf.readUInt16LE(8)}`
    const size = buf.length < 1024 ? `${buf.length} B` : `${Math.round(buf.length / 1024)} KB`
    log(`docs/media/${name}: ${dims ? dims + ', ' : ''}${size}`)
  }
}

// =====================================================================================
// Teil 2 (Electron): Attrappe des Hauptprozesses, echte Oberfläche, echter Server
// =====================================================================================

function startElectron() {
  const { app } = electron
  const sandbox = process.env.FOLDWING_MEDIA_SANDBOX
  if (!sandbox || !fs.existsSync(sandbox)) {
    console.error('Bitte über „npm run media“ starten (docs/media/make_media.mjs mit Node).')
    app.exit(2)
    return
  }

  // ---- Sandbox für Electron: Pfade setzen und prüfen, BEVOR das Fenster entsteht ----
  const data = path.join(process.env.APPDATA, 'Foldwing-Media')
  app.setPath('home', process.env.HOME)
  app.setPath('appData', process.env.APPDATA)
  app.setPath('userData', data)
  app.setPath('sessionData', data)
  app.setPath('temp', process.env.TEMP)
  app.setPath('logs', path.join(process.env.LOCALAPPDATA, 'Foldwing-Media', 'logs'))
  app.setPath('crashDumps', path.join(process.env.LOCALAPPDATA, 'Foldwing-Media', 'crashes'))
  // os.userInfo() fragt das Betriebssystem direkt und sähe den echten Kontonamen.
  os.userInfo = () => ({ uid: -1, gid: -1, username: USER, homedir: process.env.HOME, shell: null })
  syncBuiltinESMExports()

  const inside = (p) => {
    const r = path.relative(sandbox, p)
    return !!r && !r.startsWith('..') && !path.isAbsolute(r)
  }
  const checked = {
    home: app.getPath('home'),
    appData: app.getPath('appData'),
    userData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
    temp: app.getPath('temp'),
    logs: app.getPath('logs'),
    crashDumps: app.getPath('crashDumps'),
    'os.homedir()': os.homedir(),
    'os.tmpdir()': os.tmpdir(),
    'os.userInfo().homedir': os.userInfo().homedir,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERPROFILE: process.env.USERPROFILE
  }
  const outside = Object.entries(checked).filter(([, p]) => !p || !inside(p))
  if (outside.length || os.userInfo().username !== USER) {
    console.error(`Abbruch: Datenpfad außerhalb der Sandbox: ${outside.map(([k]) => k).join(', ') || 'Kontoname'}`)
    app.exit(2)
    return
  }

  app.commandLine.appendSwitch('lang', 'de')
  app.commandLine.appendSwitch('force-color-profile', 'srgb')
  app.commandLine.appendSwitch('disable-lcd-text')
  app.disableHardwareAcceleration()
  app.on('window-all-closed', () => {})

  const watchdog = setTimeout(() => {
    console.error('Abbruch: Zeitüberschreitung im Electron-Teil.')
    app.exit(3)
  }, 4 * 60_000)

  app
    .whenReady()
    .then(() => new Studio(electron, sandbox).run())
    .then(
      () => {
        clearTimeout(watchdog)
        app.exit(0)
      },
      (err) => {
        console.error(err?.stack || String(err))
        app.exit(1)
      }
    )
}

/** Steuert die Freigabe der Upload-Häppchen, damit jeder Fortschritt ein Bild bekommt. */
class Gate {
  constructor() {
    this.closed = false
    this.pending = []
    this.wakers = []
  }

  /** IPC-Seite: warten, solange eine Szene den Ablauf in der Hand hat. */
  pass(kind) {
    if (!this.closed) return Promise.resolve()
    return new Promise((resolve) => {
      this.pending.push({ kind, resolve })
      for (const wake of this.wakers.splice(0)) wake()
    })
  }

  /** Szenen-Seite: auf die nächste wartende Anfrage warten; liefert deren Art. */
  async next(timeoutMs = 10_000) {
    const start = Date.now()
    while (this.pending.length === 0) {
      if (Date.now() - start > timeoutMs) throw new Error('Zeitüberschreitung: kein Upload-Schritt')
      await new Promise((r) => {
        this.wakers.push(r)
        setTimeout(r, 100)
      })
    }
    return this.pending[0].kind
  }

  release() {
    this.pending.shift()?.resolve()
  }

  open() {
    this.closed = false
    for (const p of this.pending.splice(0)) p.resolve()
  }
}

/** Ein unsichtbares Fenster, gesteuert über das DevTools-Protokoll (Viewport, 2×, Bilder). */
class View {
  constructor(win) {
    this.win = win
    this.cdp = win.webContents.debugger
    this.cdp.attach('1.3')
  }

  send(method, params = {}) {
    return this.cdp.sendCommand(method, params)
  }

  async size(width, height) {
    this.width = width
    this.height = height
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: SCALE,
      mobile: false
    })
  }

  async scheme(value) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }]
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`Skript im Fenster: ${d.exception?.description ?? d.text}`)
    }
    return r.result.value
  }

  /** Warten, bis `expression` wahr ist. Fehler zählen als „noch nicht“ (z. B. beim Seitenwechsel). */
  async until(expression, what, timeoutMs = 10_000) {
    const start = Date.now()
    let last = ''
    for (;;) {
      try {
        if (await this.eval(expression)) return
      } catch (err) {
        last = ` (${err.message})`
      }
      if (Date.now() - start > timeoutMs) throw new Error(`Zeitüberschreitung: ${what}${last}`)
      await sleep(40)
    }
  }

  /** Warten, bis Schriften und Bilder da sind und zwei Frames gezeichnet wurden. */
  async settle() {
    const broken = await this.eval(`(async () => {
      await document.fonts.ready
      const imgs = [...document.images]
      await Promise.all(imgs.map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r })))
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return imgs.filter((i) => !i.naturalWidth).map((i) => i.alt || i.className || 'Bild')
    })()`)
    if (broken.length) throw new Error(`Bild nicht geladen: ${broken.join(', ')}`)
    await sleep(30)
  }

  /** Bildschirmfoto (PNG, 2×); `clip` in CSS-Pixeln. */
  async shot(clip) {
    await this.settle()
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip: { ...clip, scale: 1 } } : {})
    })
    return Buffer.from(r.data, 'base64')
  }

  /** Echte Mausereignisse (Hover-Zustände, Klicks) – nur im unsichtbaren Fenster. */
  async mouse(type, x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1
    })
  }

  async click(x, y) {
    await this.mouse('mouseMoved', x, y)
    await this.mouse('mousePressed', x, y)
    await this.mouse('mouseReleased', x, y)
  }

  /** Mittelpunkt und Kasten eines Elements (CSS-Pixel im Viewport); mit `text` nur
   *  der Kasten seines Textes (ein Block-Element ist sonst so breit wie sein Elternteil). */
  rect(selector, text = false) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) throw new Error('Element fehlt: ' + ${JSON.stringify(selector)})
      let target = el
      if (${text}) { target = document.createRange(); target.selectNodeContents(el) }
      const r = target.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
    })()`)
  }
}

class Studio {
  constructor(electron, sandbox) {
    this.e = electron
    this.sandbox = sandbox
    this.clock = CLOCK.screenshot
    this.gate = new Gate()
    this.ui = { theme: 'light', previews: true, bannerDismissed: true }
    this.titleBar = { color: '#ffffff', symbolColor: '#151a20' }
    this.blocked = []
    this.serverOrigin = null
    this.composeCount = 0
    fs.mkdirSync(this.work('out'), { recursive: true })
    fs.mkdirSync(this.work('compose'), { recursive: true })
  }

  work(...p) {
    return path.join(this.sandbox, ...p)
  }

  sample(file) {
    return this.work('samples', file.name)
  }

  async run() {
    this.lockDownSession()
    await this.startServer()
    this.registerIpc()

    // Dieselben Einstellungen wie das echte Hauptfenster (src/main/index.ts).
    this.appView = await this.view({
      preload: path.join(ROOT, 'out', 'preload', 'index.mjs'),
      sandbox: false,
      contextIsolation: true
    })
    // Die Oberfläche verlässt ihre eigene Seite nie (wie in der App).
    this.appView.win.webContents.on('will-navigate', (e) => e.preventDefault())
    this.pageView = await this.view({ sandbox: true, contextIsolation: true })
    this.pageView.win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(this.serverOrigin + '/')) e.preventDefault()
    })
    // Die Scrollleiste gehört zum Browser, nicht zur Seite – im Bild stört sie nur.
    await this.pageView.send('Emulation.setScrollbarsHidden', { hidden: true })
    this.composer = await this.view({ sandbox: true, contextIsolation: true })

    log('App-Oberfläche laden …')
    await this.openApp(HERO.width, HERO.height)
    log('Szene hero.gif …')
    await this.hero()
    log('Szene app.png …')
    await this.appScreenshot()
    log('Szene share-page.png …')
    await this.sharePageScreenshot()
    log('Szene file-preview.png …')
    await this.filePreviewScreenshot()
    log('Szene social-preview.png …')
    await this.socialPreview()
    if (process.env.FOLDWING_MEDIA_SITE === '1') {
      log('Szene Hintergrund für die Projektseite …')
      await this.siteBackground()
    }

    if (this.blocked.length) {
      log(`Hinweis: ${this.blocked.length} Anfrage(n) nach außen blockiert: ${[...new Set(this.blocked)].join(', ')}`)
    }
  }

  // ---- Umgebung ---------------------------------------------------------------------

  lockDownSession() {
    const { session, nativeTheme } = this.e
    nativeTheme.themeSource = 'light'
    const ses = session.defaultSession
    ses.webRequest.onBeforeRequest((details, cb) => {
      const url = details.url
      const allowed =
        /^(file|data|blob|devtools):/i.test(url) ||
        (this.serverOrigin !== null && url.startsWith(this.serverOrigin + '/'))
      if (!allowed) this.blocked.push(url.slice(0, 80))
      cb({ cancel: !allowed })
    })
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (_e, item) => item.cancel())
  }

  /** Unsichtbares Offscreen-Fenster. Erst about:blank laden – ein Viewport-Wechsel vor
   *  dem ersten Dokument bringt Electron zum Absturz. */
  async view(webPreferences) {
    const win = new this.e.BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false, spellcheck: false, ...webPreferences }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadURL('about:blank')
    return new View(win)
  }

  /** Echter Server + echte Ablage, mit zwei Freigaben als Bestand. */
  async startServer() {
    globalThis.__foldwingMediaNow = () => this.clock
    const { ShareStore, startServer } = await import(pathToFileURL(this.work('server.mjs')).href)
    this.store = new ShareStore(this.work('store'))
    await this.store.init()

    // Ein Screenshot-Link, dessen Ablauf auf 24 Stunden gesetzt wurde, und eine Notiz
    // ohne Ablauf (Standard). Die Restzeit rechnet die Oberfläche mit der echten Uhr.
    this.clock = CLOCK.screenshot
    await this.seed(FILES.screenshot, Date.now() + (23 * 60 + 10) * 60_000)
    this.clock = CLOCK.notes
    await this.seed(FILES.notes)
    this.clock = CLOCK.upload

    // Nur 127.0.0.1, wie im Relay-Modus der App. Port 0 = vom System gewählt.
    const port = Number(process.env.FOLDWING_MEDIA_PORT || 0)
    this.server = await startServer(this.store, port, { deviceId: () => DEVICE_ID }, '127.0.0.1')
    const addr = this.server.server.address()
    if (!addr || typeof addr !== 'object' || addr.address !== '127.0.0.1') {
      throw new Error('Der Server lauscht nicht ausschließlich auf 127.0.0.1.')
    }
    this.serverOrigin = `http://127.0.0.1:${this.server.port}`
    log(`Server auf ${this.serverOrigin}`)
    const font = await fetch(`${this.serverOrigin}/${DEVICE_ID}${'0'.repeat(10)}/_font/Geist-Variable.woff2`)
    if (!font.ok) throw new Error('Der Server findet die Geist-Schrift nicht (resources/fonts).')
  }

  async seed(file, expiresAt) {
    const id = this.store.begin(file.name, file.mime)
    if (!(await this.store.write(id, fs.readFileSync(this.sample(file))))) {
      throw new Error(`Ablage: ${file.name} nicht geschrieben`)
    }
    const meta = await this.store.finalize(id, expiresAt)
    if (!meta) throw new Error(`Ablage: ${file.name} nicht abgeschlossen`)
    return meta
  }

  // ---- Attrappe des Hauptprozesses: dieselben Kanäle wie src/preload/index.ts -------

  registerIpc() {
    const { ipcMain } = this.e
    const store = this.store
    const gate = this.gate
    const toShare = (meta) => ({ ...meta, url: shareUrl(meta.id) })
    const handle = (channel, fn) => ipcMain.handle(channel, (_e, arg) => fn(arg))

    handle('share:begin', (a) => store.begin(a.name, a.mime))
    handle('share:chunk', async (a) => {
      await gate.pass('chunk')
      return { ok: await store.write(a.id, Buffer.from(a.chunk)) }
    })
    handle('share:end', async (a) => {
      await gate.pass('end')
      const meta = await store.finalize(a.id, undefined)
      return meta ? { ok: true, share: toShare(meta) } : { ok: false }
    })
    handle('share:abort', async (a) => {
      await store.abort(a.id)
      return { ok: true }
    })
    handle('bundle:begin', (a) => store.beginBundle(a.files))
    handle('bundle:end', async (a) => {
      await gate.pass('end')
      // Standard-Ablauf der App ist „permanent“ (defaultTtlHours = 0).
      const meta = await store.finalizeBundle(a.id, undefined)
      return meta ? { ok: true, share: toShare(meta) } : { ok: false }
    })
    handle('bundle:abort', async (a) => {
      await store.abortBundle(a.id)
      return { ok: true }
    })
    handle('shares:list', async () =>
      (await store.list()).filter((m) => !m.expiresAt || m.expiresAt > Date.now()).map(toShare)
    )
    handle('shares:delete', async (id) => {
      await store.remove(id)
      return { ok: true }
    })
    handle('shares:setExpiry', async (a) => {
      const meta = await store.setExpiry(a.id, a.expiresAt)
      return meta ? { ok: true, share: toShare(meta) } : { ok: false }
    })

    const capture = {
      enabled: true,
      hotkey: 'PrintScreen',
      saveDir: '',
      editorPath: '',
      magnifier: true,
      alwaysSave: false,
      hotkeyActive: true,
      unavailable: null
    }
    handle('capture:get', () => capture)
    handle('capture:set', (patch) => Object.assign(capture, patch))
    handle('capture:pickSaveDir', () => ({ ok: false }))
    handle('capture:pickEditor', () => ({ ok: false }))
    handle('capture:action', () => ({ ok: false }))

    const settings = {
      defaultTtlHours: 0,
      closeToTray: true,
      autostart: true,
      scanUploads: true,
      scannerFound: true
    }
    handle('settings:get', () => settings)
    handle('settings:set', (patch) => Object.assign(settings, patch))

    // Links über den Relay, Zustand „online“ – eingespielt, es läuft kein Tunnel.
    const status = { mode: 'relay', state: 'online', text: 'Online. Deine Links funktionieren.' }
    const links = {
      mode: 'relay',
      publicBaseUrl: '',
      hasToken: false,
      relayBase: RELAY_URL,
      relayInfoUrl: `${RELAY_URL}/_/`,
      relayRulesUrl: `${RELAY_URL}/_/regeln`,
      relayPrivacyUrl: `${RELAY_URL}/_/datenschutz`,
      relayAccepted: true,
      deviceId: DEVICE_ID,
      effectiveBaseUrl: RELAY_URL,
      status
    }
    handle('links:get', () => links)
    handle('links:set', () => ({ ...links, ok: false, error: 'Nicht verfügbar' }))
    handle('links:acceptRelay', () => links)
    handle('links:testDomain', () => ({ ok: false, target: '', error: 'offline' }))

    const serverInfo = {
      running: true,
      port: this.server.port,
      linkMode: 'relay',
      effectiveBaseUrl: RELAY_URL,
      lan: null
    }
    handle('server:info', () => serverInfo)
    handle('shell:openExternal', () => undefined) // nie den Systembrowser öffnen
    handle('app:version', () => readVersion())
    handle('app:info', () => ({
      version: readVersion(),
      license: 'MIT',
      repoUrl: 'https://github.com/FynnXland/foldwing',
      releasesUrl: 'https://github.com/FynnXland/foldwing/releases/latest',
      relayBase: RELAY_URL,
      relayInfoUrl: `${RELAY_URL}/_/`,
      relayPrivacyUrl: `${RELAY_URL}/_/datenschutz`,
      relayImprintUrl: `${RELAY_URL}/_/impressum`
    }))
    const updates = { auto: true, mode: 'auto', releasesUrl: 'https://github.com/FynnXland/foldwing/releases/latest' }
    handle('updates:get', () => updates)
    handle('updates:set', () => updates)
    handle('update:status', () => ({ state: 'idle' }))
    handle('update:check', () => ({ state: 'none' }))
    handle('update:install', () => undefined)

    ipcMain.on('ui:get', (e) => {
      e.returnValue = { ...this.ui }
    })
    ipcMain.on('ui:set', (_e, patch) => Object.assign(this.ui, patch))
    ipcMain.on('window:titleBarOverlay', (_e, colors) => {
      this.titleBar = colors
    })
    for (const channel of ['window:app-ready', 'capture:confirm', 'capture:ready', 'capture:cancel', 'capture:actions:close']) {
      ipcMain.on(channel, () => {})
    }
  }

  // ---- App-Fenster ------------------------------------------------------------------

  async openApp(width, height) {
    const v = this.appView
    await v.size(width, height)
    await v.scheme('light')
    await v.win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
    // Übergänge aus: Jedes Bild zeigt den fertigen Zustand, nicht eine Zwischenstufe.
    await v.win.webContents.insertCSS(
      '*, *::before, *::after { transition: none !important; animation: none !important; }'
    )
    await v.until("document.querySelectorAll('.share-card').length === 2", 'Freigaben-Liste')
    // „Kopieren“ soll den Knopf umschalten, aber nicht die echte Zwischenablage füllen.
    await v.eval(`(() => {
      const fake = { writeText: () => Promise.resolve() }
      try { navigator.clipboard.writeText = fake.writeText } catch {}
      if (!navigator.clipboard || navigator.clipboard.writeText !== fake.writeText) {
        Object.defineProperty(navigator, 'clipboard', { value: fake, configurable: true })
      }
      return true
    })()`)
  }

  /** Scrollt die Freigaben-Ansicht so, dass `selector` `offset` Pixel unter der Kopfzeile steht. */
  async scrollTo(selector, offset) {
    await this.appView.eval(`(() => {
      const sc = document.querySelector('.app__scroll')
      const el = document.querySelector(${JSON.stringify(selector)})
      sc.scrollTop = 0
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top
      sc.scrollTop = Math.max(0, top - ${offset})
      return sc.scrollTop
    })()`)
  }

  /** Teilen-Ansicht ganz nach oben: Statuszeile mit ihrem natürlichen Abstand zur Kopfzeile. */
  async scrollHome() {
    await this.appView.eval(`(() => { document.querySelector('.app__scroll').scrollTop = 0; return true })()`)
  }

  /** Die drei Beispieldateien wie aus dem Explorer über die Ablagefläche ziehen. */
  async prepareDrag() {
    const files = BUNDLE.map((f) => ({
      name: f.name,
      type: f.mime,
      b64: fs.readFileSync(this.sample(f)).toString('base64')
    }))
    await this.appView.eval(`(() => {
      const files = ${JSON.stringify(files)}.map((f) => new File(
        [Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name,
        { type: f.type, lastModified: ${CLOCK.upload} }))
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(f)
      window.__mediaDrag = dt
      const zone = document.querySelector('.dropzone')
      for (const type of ['dragenter', 'dragover']) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
      return true
    })()`)
    await this.appView.until("document.querySelector('.dropzone').classList.contains('dropzone--over')", 'Ablagefläche hervorgehoben')
    await this.appView.until("document.querySelector('.dropzone__title').textContent.includes('Loslassen')", 'Loslassen zum Teilen')
  }

  async drop() {
    await this.appView.eval(`(() => {
      document.querySelector('.dropzone').dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__mediaDrag }))
      return true
    })()`)
  }

  // ---- Szenen -----------------------------------------------------------------------

  /** hero.gif: Ablegen → Sammel-Karte mit Fortschritt → Link kopiert → Empfänger-Seiten. */
  async hero() {
    const v = this.appView
    const film = new Film(this.work('frames'))
    const W = v.width
    const H = v.height

    // 1) Poster: Hauptfenster mit Statuszeile, Ablagefläche und dem Bestand.
    await this.scrollHome()
    film.add(await this.appFrame(await v.shot()), 2.0)

    // 2) Drei Dateien schweben über der Ablagefläche (Zieh-Bild rechts neben dem Titel).
    await this.prepareDrag()
    const title = await v.rect('.dropzone__title', true)
    const grab = { x: title.x + title.width + 30, y: title.y - 6 }
    film.add(await this.appFrame(await v.shot(), { pointer: grab, ghost: true }), 0.8)

    // 3) Losgelassen: EINE Sammel-Karte, der Balken läuft. Jedes Bild ist ein echter
    //    Zustand nach einem Upload-Häppchen; nahezu gleiche Stände werden übersprungen.
    this.gate.closed = true
    await this.drop()
    await v.until("document.querySelectorAll('.share-card').length === 3", 'Sammel-Karte')
    await this.scrollHome()
    let shownPct = -100
    for (;;) {
      const kind = await this.gate.next()
      await v.settle()
      const pct = await v.eval(`(() => {
        const m = /(\\d+)\\s*%/.exec(document.querySelector('${NEWEST} .ftile__pct')?.textContent ?? '')
        return m ? Number(m[1]) : -1
      })()`)
      if (pct >= 0 && pct - shownPct >= 15) {
        film.add(await this.appFrame(await v.shot()), 0.35)
        shownPct = pct
      }
      this.gate.release()
      if (kind === 'end') break
    }
    this.gate.open()
    await v.until(`!!document.querySelector('${NEWEST} .linkfield__url')`, 'Link der Sammlung')
    this.bundleUrl = await v.eval(`document.querySelector('${NEWEST} .linkfield__url').textContent`)
    this.bundleId = this.bundleUrl.split('/').pop().slice(DEVICE_ID.length)

    // 4) Fertig: Link, dann „Link kopieren“ → „Kopiert“. Der Zeiger sitzt am rechten
    //    Rand des Knopfs, damit die Beschriftung lesbar bleibt.
    film.add(await this.appFrame(await v.shot()), 0.9)
    const btn = await v.rect(`${NEWEST} .linkfield__btn`)
    const at = { x: btn.x + btn.width - 12, y: btn.y + btn.height - 9 }
    await v.mouse('mouseMoved', at.x, at.y)
    film.add(await this.appFrame(await v.shot(), { pointer: at }), 0.4)
    await v.click(at.x, at.y)
    await v.until(`document.querySelector('${NEWEST} .linkfield__btn').textContent.includes('Kopiert')`, 'Kopiert')
    film.add(await this.appFrame(await v.shot(), { pointer: at }), 1.3)
    await v.mouse('mouseMoved', W - 4, H - 4)

    // 5) Harter Schnitt: Was der Empfänger im Browser sieht.
    const p = this.pageView
    await p.size(W, H - BROWSER_BAR)
    await p.scheme('light')
    await p.win.loadURL(this.serverOrigin + sharePath(this.bundleId))
    film.add(await this.browserFrame(await p.shot(), 'light'), 2.0)
    // Zeiger ans Ende des Dateinamens: Er soll den Link treffen, nicht die Zeile darunter verdecken.
    const link = await p.rect(`.frow__name[href$="/${await this.fidOf(FILES.sheet)}"]`, true)
    const target = { x: link.x + link.width - 3, y: link.y + link.height - 5 }
    await p.mouse('mouseMoved', target.x, target.y)
    film.add(await this.browserFrame(await p.shot(), 'light', { pointer: target }), 0.6)
    await p.click(target.x, target.y)
    // Relay-Pfad der Einzelansicht: /<T>/<F>
    await p.until(`location.pathname.split('/').length === 3 && document.readyState === 'complete'`, 'Einzelansicht')
    await p.mouse('mouseMoved', W - 4, H - BROWSER_BAR - 4)
    film.add(await this.browserFrame(await p.shot(), 'light'), 2.4)
    log(`hero.gif: ${film.n} Bilder, ${(film.n / FPS).toFixed(1)} s`)
  }

  async fidOf(file) {
    const meta = await this.store.get(this.bundleId)
    const f = meta?.files?.find((x) => x.name === file.name)
    if (!f) throw new Error(`${file.name} fehlt in der Sammlung`)
    return f.fid
  }

  /** app.png: Hauptfenster, Liste mit Sammlung (Vorschaubilder), Screenshot, Notiz. */
  async appScreenshot() {
    const v = this.appView
    await v.mouse('mouseMoved', 1, 1)
    // „Kopiert“ springt nach 1,8 s von selbst zurück – auf den Ruhezustand warten.
    await v.until(`document.querySelector('${NEWEST} .linkfield__btn').textContent.includes('Link kopieren')`, 'Link kopieren')
    // Fensterhöhe so wählen, dass die ganze Teilen-Ansicht ohne Scrollen hineinpasst:
    // Kopfzeile plus Inhaltshöhe des Scrollbereichs (samt seinem Abstand unten).
    await v.size(APP_PNG_WIDTH, 1000)
    const height = await v.eval(`(() => {
      const sc = document.querySelector('.app__scroll')
      return Math.ceil(sc.getBoundingClientRect().top + sc.scrollHeight)
    })()`)
    await v.size(APP_PNG_WIDTH, height)
    await this.scrollHome()
    const png = await this.appFrame(await v.shot())
    fs.writeFileSync(this.work('out', 'app.png'), png)
  }

  async sharePageScreenshot() {
    const p = this.pageView
    await p.scheme('light')
    const png = await this.fullPage(p, this.serverOrigin + sharePath(this.bundleId), 'light')
    fs.writeFileSync(this.work('out', 'share-page.png'), png)
  }

  async filePreviewScreenshot() {
    const p = this.pageView
    await p.scheme('dark')
    const url = this.serverOrigin + sharePath(this.bundleId, await this.fidOf(FILES.sheet))
    const png = await this.fullPage(p, url, 'dark')
    fs.writeFileSync(this.work('out', 'file-preview.png'), png)
  }

  /** Ganze Seite in Browser-Rahmen: Höhe = Inhalt, Breite = README-Spalte. */
  async fullPage(p, url, theme) {
    await p.size(PAGE_PNG_WIDTH, 400)
    await p.win.loadURL(url)
    await p.settle()
    const height = await p.eval('Math.ceil(document.querySelector("main").getBoundingClientRect().bottom)')
    await p.size(PAGE_PNG_WIDTH, height)
    await p.mouse('mouseMoved', PAGE_PNG_WIDTH - 2, height - 2)
    return this.browserFrame(await p.shot(), theme)
  }

  /** social-preview.png: 1280×640, deckend; rechts die echte Sammel-Karte (verkleinert). */
  async socialPreview() {
    const v = this.appView
    await v.size(APP_PNG_WIDTH, 1000)
    const { file: cardFile, width, height } = await this.bundleCard()
    const shown = { width: SOCIAL_CARD_WIDTH, height: Math.round((height * SOCIAL_CARD_WIDTH) / width) }
    const chips = ['Windows & Linux', 'No account', 'Original files', 'MIT']
      .map((c) => `<span class="chip">${c}</span>`)
      .join('')
    const html = `
      <div class="social">
        <div class="glow"></div>
        <div class="left">
          <div class="brand"><span class="logo">${readLogo()}</span><span class="name">Foldwing</span></div>
          <div class="claim">Share files by link, straight from your own PC.</div>
          <div class="sub">Drop files in, get a link. Recipients preview them in the browser and download the originals, bit for bit.</div>
          <div class="chips">${chips}</div>
        </div>
        <img class="card" src="${cardFile}" style="width:${shown.width}px;height:${shown.height}px" alt="">
      </div>`
    const png = await this.compose(1280, 640, html, SOCIAL_CSS, 1)
    fs.writeFileSync(this.work('out', 'social-preview.png'), png)
  }

  /** Die Sammel-Karte aus dem GIF, freigestellt (2×). */
  async bundleCard() {
    const v = this.appView
    await v.size(APP_PNG_WIDTH, 1000)
    await v.mouse('mouseMoved', 1, 1)
    await this.scrollTo('.list-head', 14)
    const card = await v.rect(NEWEST)
    const png = await v.shot({ x: card.x, y: card.y, width: card.width, height: card.height })
    return { file: this.writeCompose('card', png), width: card.width, height: card.height }
  }

  /**
   * Hintergrund für eine Projektseite (--site): 1920×1200, ruhig, ohne Fenster und Leisten.
   * Die Sammel-Karte steht in der Mitte (Handys zeigen nur die Mitte), die Ränder oben und
   * unten bleiben frei, weil die Seite dort ihren eigenen Text abdunkelt.
   */
  async siteBackground() {
    const { file, width, height } = await this.bundleCard()
    const w = 720
    const h = Math.round((height * w) / width)
    const html = `
      <div class="site">
        <div class="plane">${readLogo('plain')}</div>
        <img class="card" src="${file}" style="width:${w}px;height:${h}px" alt="">
      </div>`
    const png = await this.compose(1920, 1200, html, SITE_CSS, 1)
    fs.writeFileSync(this.work('out', 'site-background.png'), png)
  }

  // ---- Bildaufbau (Rahmen, Demo-Elemente) --------------------------------------------

  writeCompose(name, png) {
    const file = `${name}_${String(++this.composeCount).padStart(3, '0')}.png`
    fs.writeFileSync(this.work('compose', file), png)
    return file
  }

  /** Eine HTML-Seite in einem eigenen unsichtbaren Fenster rendern und abfotografieren. */
  async compose(width, height, body, css, scale = SCALE) {
    const fonts = pathToFileURL(path.join(ROOT, 'resources', 'fonts')).href
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face { font-family: 'Geist'; src: url('${fonts}/Geist-Variable.woff2') format('woff2'); font-weight: 100 900; }
      @font-face { font-family: 'Geist Mono'; src: url('${fonts}/GeistMono-Variable.woff2') format('woff2'); font-weight: 100 900; }
      html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
      body { position: relative; font-family: 'Geist', sans-serif; }
      .base { position: absolute; left: 0; display: block; image-rendering: pixelated; }
      .frame { position: absolute; inset: 0; box-shadow: inset 0 0 0 1px rgba(110, 120, 135, 0.35); pointer-events: none; }
      ${DEMO_CSS}
      ${css}
    </style></head><body>${body}</body></html>`
    const file = this.work('compose', `page_${String(++this.composeCount).padStart(3, '0')}.html`)
    fs.writeFileSync(file, html)
    const c = this.composer
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
    await c.win.loadFile(file)
    return c.shot()
  }

  /** App-Bild + Fensterknöpfe (zeichnet sonst Windows) + optionale Demo-Elemente. */
  async appFrame(png, demo = {}) {
    const w = this.appView.width
    const h = this.appView.height
    const base = this.writeCompose('app', png)
    const body = `
      <img class="base" src="${base}" style="top:0;width:${w}px;height:${h}px" alt="">
      ${captionButtons(this.titleBar.symbolColor)}
      ${demo.ghost ? this.ghost(demo.pointer) : ''}
      ${demo.pointer ? pointer(demo.pointer) : ''}
      <div class="frame"></div>`
    return this.compose(w, h, body, '')
  }

  /** Seite des Empfängers unter einer schlichten, erfundenen Browser-Leiste. */
  async browserFrame(png, theme, demo = {}) {
    const p = this.pageView
    const w = p.width
    const h = p.height + BROWSER_BAR
    const base = this.writeCompose('page', png)
    const url = new URL(await p.eval('location.href'))
    const body = `
      ${browserBar(theme, url.pathname)}
      <img class="base" src="${base}" style="top:${BROWSER_BAR}px;width:${w}px;height:${p.height}px" alt="">
      ${demo.pointer ? pointer({ x: demo.pointer.x, y: demo.pointer.y + BROWSER_BAR }) : ''}
      <div class="frame"></div>`
    return this.compose(w, h, body, '')
  }

  /** Zieh-Bild: drei Kärtchen mit den echten Dateien und der Anzahl. */
  ghost(at) {
    const thumbs = [FILES.sheet, FILES.plan, FILES.moodboard]
      .map((f, i) => {
        const rot = [-11, 7, -2][i]
        const inner = f.mime.startsWith('image/')
          ? `<img src="${pathToFileURL(this.sample(f)).href}" alt="">`
          : `<span class="sheet">${SHEET_ICON}</span>`
        return `<span class="tile" style="transform: rotate(${rot}deg)">${inner}</span>`
      })
      .join('')
    return `<div class="ghost" style="left:${at.x + 16}px;top:${at.y + 20}px">${thumbs}<span class="count">3</span></div>`
  }
}

/** Einzelbilder sammeln; `seconds` hält ein Bild (Duplikate kosten im GIF fast nichts). */
class Film {
  constructor(dir) {
    this.dir = dir
    this.n = 0
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  }

  add(png, seconds) {
    const count = Math.max(1, Math.round(seconds * FPS))
    const name = () => path.join(this.dir, `f_${String(this.n).padStart(5, '0')}.png`)
    const first = name()
    fs.writeFileSync(first, png)
    this.n++
    for (let i = 1; i < count; i++) {
      fs.copyFileSync(first, name())
      this.n++
    }
  }
}

/**
 * Das Logo-SVG aus scripts/make-icon.mjs. `plain`: nur der Flieger ohne Kachel, einfarbig
 * weiß (für den Hintergrund der Projektseite).
 */
function readLogo(variant) {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'make-icon.mjs'), 'utf8')
  const svg = src.match(/const SVG = `(<svg[\s\S]*?<\/svg>)`/)[1]
  if (variant !== 'plain') return svg
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => `<path d="${m[1]}" fill="#ffffff"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${paths.join('')}</svg>`
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

// ---- Maße und Demo-Elemente ---------------------------------------------------------

/** GIF-Leinwand in CSS-Pixeln (2× gerendert = 1520×1280, angezeigt mit width="760"). */
const HERO = { width: 760, height: 640 }
const BROWSER_BAR = 48
const APP_PNG_WIDTH = 838
const PAGE_PNG_WIDTH = 838
const SOCIAL_CARD_WIDTH = 500
/** Die oberste Karte der Liste = die neueste Freigabe (hier: die Sammlung aus dem GIF). */
const NEWEST = '.share-list > .share-card:first-child'

const SHEET_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18v14H3zM3 10h18M9 5v14"/></svg>`

/** Windows-Fensterknöpfe (Minimieren, Maximieren, Schließen) in der Farbe der App. */
function captionButtons(color) {
  const s = `stroke="${color}" stroke-width="1" fill="none" shape-rendering="crispEdges"`
  return `<div class="caption">
    <span><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5.5H10" ${s}/></svg></span>
    <span><svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" ${s}/></svg></span>
    <span><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="${color}" stroke-width="1.1"/></svg></span>
  </div>`
}

/** Mauszeiger (Demo-Element), Spitze bei `at`. */
function pointer(at) {
  return `<svg class="pointer" style="left:${at.x - 2}px;top:${at.y - 2}px" width="22" height="30" viewBox="0 0 22 30">
      <path d="M2 2 L2 24 L7.6 18.9 L11.6 27.6 L15.6 25.9 L11.7 17.4 L19 17.4 Z" fill="#ffffff" stroke="#151a20" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`
}

/** Schlichte Browser-Leiste ohne Marke: Navigation und Adressfeld mit erfundener Domain. */
function browserBar(theme, pathname) {
  const host = new URL(RELAY_URL).host
  const icon = (d) =>
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
  return `<div class="bbar bbar--${theme}" style="height:${BROWSER_BAR}px">
    <span class="bbar__nav">${icon('M15 18l-6-6 6-6')}${icon('M9 18l6-6-6-6')}${icon('M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5')}</span>
    <span class="bbar__addr">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      <span><span class="bbar__host">${host}</span>${pathname}</span>
    </span>
  </div>`
}

const DEMO_CSS = `
  .caption { position: absolute; top: 0; right: 0; display: flex; height: 44px; }
  .caption span { width: 46px; height: 44px; display: grid; place-items: center; }
  .pointer { position: absolute; filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.35)); z-index: 5; }
  .ghost { position: absolute; width: 66px; height: 66px; z-index: 4; }
  .ghost .tile { position: absolute; inset: 0; border-radius: 12px; overflow: hidden; background: #ffffff;
    box-shadow: 0 0 0 2px #ffffff, 0 6px 16px rgba(21, 26, 32, 0.22); opacity: 0.94; }
  .ghost .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ghost .sheet { width: 100%; height: 100%; display: grid; place-items: center; color: #16a36a;
    background: color-mix(in srgb, #16a36a 12%, #ffffff); }
  .ghost .count { position: absolute; right: -10px; top: -10px; min-width: 24px; height: 24px; padding: 0 7px;
    border-radius: 12px; background: #2563eb; color: #ffffff; font: 600 13px/24px 'Geist', sans-serif;
    text-align: center; box-shadow: 0 0 0 2px #ffffff; z-index: 2; }
  .bbar { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 14px;
    padding: 0 14px; box-sizing: border-box; font: 400 13.5px/1 'Geist', sans-serif; }
  .bbar--light { background: #e9edf2; color: #4c5763; box-shadow: inset 0 -1px 0 #d5dbe3; }
  .bbar--dark { background: #1c2128; color: #98a2b0; box-shadow: inset 0 -1px 0 #2b3139; }
  .bbar__nav { display: flex; gap: 10px; opacity: 0.85; }
  .bbar__addr { flex: 1; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 14px;
    border-radius: 16px; min-width: 0; white-space: nowrap; overflow: hidden; }
  .bbar--light .bbar__addr { background: #ffffff; }
  .bbar--dark .bbar__addr { background: #0f1318; }
  .bbar--light .bbar__host { color: #151a20; }
  .bbar--dark .bbar__host { color: #eef1f5; }
`

const SOCIAL_CSS = `
  .social { position: absolute; inset: 0; background: #0c0f13; overflow: hidden; }
  .glow { position: absolute; left: 640px; top: -60px; width: 760px; height: 760px; border-radius: 50%;
    background: radial-gradient(closest-side, rgba(37, 99, 235, 0.30), rgba(37, 99, 235, 0)); }
  .left { position: absolute; left: 72px; top: 50%; transform: translateY(-50%); width: 590px; color: #eef1f5; }
  .brand { display: flex; align-items: center; gap: 22px; }
  .logo svg { width: 88px; height: 88px; display: block; }
  .name { font-size: 74px; font-weight: 600; letter-spacing: -0.02em; line-height: 1; }
  .claim { margin-top: 36px; font-size: 34px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.2;
    text-wrap: balance; }
  .sub { margin-top: 14px; font-size: 20px; line-height: 1.5; color: #98a2b0; text-wrap: balance; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 30px; }
  .chip { height: 36px; padding: 0 15px; display: inline-flex; align-items: center; border-radius: 18px;
    border: 1.5px solid #2b3440; background: #151a20; color: #c9d0da; font-size: 15.5px; font-weight: 500; }
  .card { position: absolute; right: 60px; top: 50%; transform: translateY(-50%); border-radius: 16px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06); }
`

/** Hintergrund der Projektseite: Dunkelblau aus dem Logo, ein großer, blasser Flieger als Motiv. */
const SITE_CSS = `
  .site { position: absolute; inset: 0; overflow: hidden;
    background: radial-gradient(ellipse 70% 60% at 50% 50%, #1a3070 0%, #0d1a3a 70%); }
  .plane { position: absolute; left: 50%; top: 50%; width: 1500px; height: 1500px;
    transform: translate(-46%, -54%); opacity: 0.06; }
  .plane svg { width: 100%; height: 100%; display: block; }
  .site .card { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); border-radius: 16px;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06); }
`

// =====================================================================================
// Einstieg. Unter Electron ohne Top-Level-await: Pfade und Schalter müssen gesetzt sein,
// bevor Electron „ready“ meldet – das erledigt startElectron() synchron.
// =====================================================================================

if (process.versions.electron) {
  startElectron()
} else {
  await launch().catch((err) => {
    console.error(`[media] Abbruch: ${err.message}`)
    process.exitCode = 1
  })
}
