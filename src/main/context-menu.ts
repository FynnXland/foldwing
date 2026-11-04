import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { writeFile, readFile, rm, mkdir, copyFile, chmod } from 'fs/promises'
import { dirname, isAbsolute, join } from 'path'
import { tmpdir } from 'os'
import { desktopExecQuote, isLinux, isWindows, xdgDataHome } from './platform'
import { APP_NAME } from './brand'

/**
 * „Mit Foldwing teilen" im Dateimanager – je Plattform anders verankert:
 *
 * Windows: klassischer Rechtsklick-Eintrag, per-user in HKCU registriert (keine
 * Adminrechte nötig). Auf Windows 11 erscheint er unter „Weitere Optionen
 * anzeigen" – der direkte Platz im neuen Kontextmenü ist paketierten (MSIX-)Apps
 * mit COM-Handler vorbehalten, was eine klassische Electron-App nicht ist.
 *
 * Linux: eine .desktop-Datei in ~/.local/share/applications. Über die
 * KDE-Zuordnung `all/allfiles` taucht „Mit Foldwing teilen" in Dolphins
 * „Öffnen mit"-Menü für jede Datei auf. Das ist KDE-spezifisch: GNOME & Co.
 * zeigen den Eintrag nur in der vollständigen Anwendungsliste, nicht im
 * „Öffnen mit"-Menü selbst. Für GNOME kommt deshalb, wenn Nautilus da ist, ein
 * Nautilus-Skript dazu (Rechtsklick → Skripte → Mit Foldwing teilen). Eine
 * Zuordnung zu application/octet-stream wäre kürzer, könnte Foldwing aber zur
 * Standard-App für unbekannte Dateien machen – ein Doppelklick würde sie teilen.
 *
 * Der Eintrag ruft die App als `"<exe>" --fs-share "<datei>"` auf; der
 * Main-Prozess lädt die Datei dann über den normalen Ablage-/Freigabe-Pfad hoch.
 */
const MENU_KEY = 'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\Foldwing'
const LABEL = `Mit ${APP_NAME} teilen`
const DESKTOP_FILE = 'foldwing-share.desktop'
/** Dateiname = Menütext im Nautilus-Untermenü „Skripte". */
const NAUTILUS_SCRIPT = LABEL

/** Wert für eine .reg-Datei absichern: Backslashes verdoppeln, Anführungszeichen escapen. */
export function regEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Registriert den Eintrag fürs aktuelle System. Gibt true bei Erfolg zurück (sonst still false). */
export async function registerShareContextMenu(exePath: string): Promise<boolean> {
  if (isWindows) return registerWindows(exePath)
  if (isLinux) return registerLinux(exePath)
  return false
}

/**
 * Den Eintrag wieder entfernen. Gegenstück zu registerShareContextMenu; die App ruft es
 * derzeit nicht auf (beim Deinstallieren unter Windows entfernt der Installer den Eintrag).
 */
export async function unregisterShareContextMenu(): Promise<void> {
  if (isWindows) return unregisterWindows()
  if (isLinux) return unregisterLinux()
}

// ---- Linux (.desktop-Datei) ----------------------------------------------

function desktopFilePath(): string {
  return join(xdgDataHome(), 'applications', DESKTOP_FILE)
}

function nautilusScriptPath(): string {
  return join(xdgDataHome(), 'nautilus', 'scripts', NAUTILUS_SCRIPT)
}

/** GNOME-Dateimanager vorhanden (Paket oder schon benutzter Nautilus-Ordner)? */
function hasNautilus(): boolean {
  return (
    existsSync('/usr/bin/nautilus') ||
    existsSync('/usr/local/bin/nautilus') ||
    existsSync(join(xdgDataHome(), 'nautilus'))
  )
}

/** Text für die Shell in einfache Anführungszeichen setzen (' wird zu '\''). */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Exec-Zeile der .desktop-Datei – eine Stelle für Schreiben und Prüfen. */
function desktopExecLine(exePath: string): string {
  return `Exec=${desktopExecQuote(exePath)} --fs-share %f\n`
}

/**
 * Nautilus-Skript. Nautilus übergibt die markierten Dateien als Argumente, lokal je
 * nach Version als Name relativ zum aktuellen Ordner oder als absoluten Pfad. Bei
 * der laufenden App muss ein absoluter Pfad ankommen, sie hat ein anderes
 * Arbeitsverzeichnis. Ordner und Nicht-Lokales (URIs) werden übersprungen. Jede
 * Datei startet einen eigenen Aufruf im Hintergrund – sonst hinge das Skript, wenn
 * erst der Aufruf Foldwing startet. Rein, damit testbar.
 */
export function buildNautilusScript(exePath: string): string {
  return (
    '#!/bin/sh\n' +
    `# Angelegt von ${APP_NAME}: Rechtsklick > Skripte > ${LABEL}\n` +
    `exe=${shSingleQuote(exePath)}\n` +
    'for f in "$@"; do\n' +
    '  case "$f" in /*) p="$f" ;; *) p="$PWD/$f" ;; esac\n' +
    '  [ -f "$p" ] || continue\n' +
    '  "$exe" --fs-share "$p" >/dev/null 2>&1 &\n' +
    'done\n'
  )
}

/** Die .desktop-Datei für „Öffnen mit" – rein, damit testbar. */
export function buildShareDesktopEntry(exePath: string, iconPath: string | null): string {
  return (
    '[Desktop Entry]\n' +
    'Type=Application\n' +
    `Name=${LABEL}\n` +
    'Comment=Datei sofort per Link teilen\n' +
    desktopExecLine(exePath) +
    (iconPath ? `Icon=${iconPath}\n` : '') +
    'Terminal=false\n' +
    'NoDisplay=false\n' +
    // Nur EINE Hauptkategorie, sonst steht der Eintrag in manchen Menüs doppelt.
    'Categories=Utility;\n' +
    // KDE-Pseudo-Typ: gilt für alle Dateien -> Eintrag direkt im „Öffnen mit"-Menü.
    'MimeType=all/allfiles;\n'
  )
}

/** Dateimanager-Caches auffrischen, damit der Eintrag sofort auftaucht (optional). */
function refreshDesktopDatabase(): void {
  try {
    const p = spawn('update-desktop-database', [join(xdgDataHome(), 'applications')], {
      stdio: 'ignore'
    })
    p.on('error', () => {})
  } catch {
    /* Werkzeug fehlt -> die Umgebung liest die Datei trotzdem (nur evtl. später) */
  }
}

async function registerLinux(exePath: string): Promise<boolean> {
  // In der gepackten App liegt das Icon in resources/ (extraResources). Beim
  // AppImage ist dieser Pfad flüchtig (Extraktions-Ordner unter /tmp) – deshalb
  // eine stabile Kopie unter ~/.local/share/icons ablegen und die verwenden.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  let iconPath = resourcesPath ? join(resourcesPath, 'icon.png') : ''
  try {
    const stableIcon = join(xdgDataHome(), 'icons', 'foldwing.png')
    await mkdir(dirname(stableIcon), { recursive: true })
    await copyFile(iconPath, stableIcon)
    iconPath = stableIcon
  } catch {
    /* Kopie fehlgeschlagen -> resources-Pfad nutzen (bei .deb ohnehin stabil) */
  }
  // Icon-Zeile nur schreiben, wenn wirklich ein absoluter, vorhandener Pfad
  // feststeht – sonst zeigt der Eintrag auf nichts, statt gar kein Icon zu haben.
  const icon = iconPath && isAbsolute(iconPath) && existsSync(iconPath) ? iconPath : null
  try {
    await mkdir(join(xdgDataHome(), 'applications'), { recursive: true })
    await writeFile(desktopFilePath(), buildShareDesktopEntry(exePath, icon), 'utf8')
    refreshDesktopDatabase()
  } catch {
    return false
  }
  if (hasNautilus()) {
    try {
      await mkdir(dirname(nautilusScriptPath()), { recursive: true })
      await writeFile(nautilusScriptPath(), buildNautilusScript(exePath), 'utf8')
      await chmod(nautilusScriptPath(), 0o755)
    } catch {
      /* nur ein Zusatz – der .desktop-Eintrag steht trotzdem */
    }
  }
  return true
}

async function unregisterLinux(): Promise<void> {
  await rm(desktopFilePath(), { force: true }).catch(() => {})
  await rm(nautilusScriptPath(), { force: true }).catch(() => {})
  refreshDesktopDatabase()
}

// ---- Windows (Registry) ---------------------------------------------------

/** Der Befehl, den der Eintrag ausführt – eine Stelle für Registrieren und Prüfen. */
function shareCommand(exePath: string): string {
  return `"${exePath}" --fs-share "%1"`
}

/**
 * Aus der Ausgabe von `reg query <schlüssel> /ve` den Standardwert lesen. Dessen
 * Bezeichnung („(Standard)", „(Default)" …) hängt von der Systemsprache ab –
 * deshalb am Typ REG_SZ / REG_EXPAND_SZ festmachen. Rein, damit testbar.
 */
export function parseRegDefaultValue(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /\sREG_(?:EXPAND_)?SZ(?:\s+(.*))?$/.exec(line)
    if (m) return (m[1] ?? '').trimEnd()
  }
  return null
}

/**
 * Steht der Eintrag schon so da, wie diese Installation ihn braucht? Geprüft wird
 * direkt in der Registry bzw. der .desktop-Datei, nicht über einen Merker in der
 * Config: Ein Update startet den Deinstallierer der alten Version, und der hat den
 * Eintrag bis 1.3.0 jedes Mal gelöscht, während der Merker „erledigt" behauptete.
 */
export async function isShareContextMenuRegistered(exePath: string): Promise<boolean> {
  if (isWindows) {
    const out = await new Promise<string>((resolve) => {
      let buf = ''
      try {
        const p = spawn(regExePath(), ['query', `${MENU_KEY}\\command`, '/ve'], { windowsHide: true })
        // reg.exe schreibt in der OEM-Codepage. Für ASCII-Pfade ist das egal; ein Pfad
        // mit Umlauten passt dann nie – dann wird eben bei jedem Start neu eingetragen.
        p.stdout?.on('data', (d: Buffer) => (buf += d.toString('latin1')))
        p.on('error', () => resolve(''))
        p.on('close', () => resolve(buf))
      } catch {
        resolve('')
      }
    })
    const value = parseRegDefaultValue(out)
    return value !== null && value.toLowerCase() === shareCommand(exePath).toLowerCase()
  }
  if (isLinux) {
    try {
      const text = await readFile(desktopFilePath(), 'utf8')
      if (!text.includes(desktopExecLine(exePath))) return false
      // Bis 1.4.0 standen zwei Hauptkategorien drin -> einmal neu schreiben lassen.
      if (!text.includes('Categories=Utility;\n')) return false
      if (!hasNautilus()) return true
      return (await readFile(nautilusScriptPath(), 'utf8')) === buildNautilusScript(exePath)
    } catch {
      return false
    }
  }
  return false
}

/** Baut den .reg-Dateiinhalt für den Import – reine Funktion, damit sie testbar ist. */
export function buildRegContent(exePath: string): string {
  const command = shareCommand(exePath)
  return (
    'Windows Registry Editor Version 5.00\r\n\r\n' +
    `[${MENU_KEY}]\r\n` +
    `@="${regEscape(LABEL)}"\r\n` +
    `"Icon"="${regEscape(exePath)},0"\r\n\r\n` +
    `[${MENU_KEY}\\command]\r\n` +
    `@="${regEscape(command)}"\r\n`
  )
}

/** reg.exe über absoluten Pfad statt PATH starten (kein Vorbeischmuggeln über PATH-Manipulation). */
export function regExePath(): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe')
}

async function registerWindows(exePath: string): Promise<boolean> {
  // Reiner ASCII-Inhalt -> als latin1 schreiben, reg.exe importiert das zuverlässig.
  const reg = buildRegContent(exePath)
  // Zufälliger Name (statt Date.now()) + 'wx': verhindert, dass zwei gleichzeitige
  // Aufrufe sich die Temp-Datei teilen oder eine bestehende Datei überschreiben.
  const file = join(tmpdir(), `foldwing-ctx-${randomUUID()}.reg`)
  try {
    await writeFile(file, reg, { encoding: 'latin1', flag: 'wx' })
    await new Promise<void>((resolve, reject) => {
      const p = spawn(regExePath(), ['import', file], { windowsHide: true })
      p.on('error', reject)
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`reg exit ${code}`))))
    })
    return true
  } catch {
    return false
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}

async function unregisterWindows(): Promise<void> {
  await new Promise<void>((resolve) => {
    const p = spawn(regExePath(), ['delete', MENU_KEY, '/f'], { windowsHide: true })
    p.on('error', () => resolve())
    p.on('exit', () => resolve())
  })
}

/**
 * Aus den Programmargumenten den zu teilenden Dateipfad ziehen (Marker `--fs-share`).
 * Rein (ohne Seiteneffekte), damit testbar. Gibt null zurück, wenn kein Teilen gemeint ist.
 *
 * WICHTIG: Beim Electron-`second-instance`-Event werden die Argumente umsortiert
 * (Schalter nach vorn, Positionsargumente ans Ende, Chromium-eigene Schalter wie
 * `--allow-file-access-from-files` dazwischen). Deshalb NICHT „das Argument nach dem
 * Marker" nehmen, sondern das letzte echte Positionsargument: kein Schalter (`-…`),
 * nicht der App-Pfad `.`, nicht das Programm selbst (Index 0).
 */
export function extractSharePath(argv: string[]): string | null {
  if (!argv.includes('--fs-share')) return null
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i]
    if (a && !a.startsWith('-') && a !== '.') return a
  }
  return null
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain',
  json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'text/javascript', ts: 'text/plain', yml: 'text/plain', yaml: 'text/plain',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

/** MIME-Typ grob aus der Dateiendung ableiten (für sinnvolle Vorschau). */
export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return MIME[ext] || 'application/octet-stream'
}
