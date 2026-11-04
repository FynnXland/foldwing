/**
 * Kleine Plattform-Weichen für den Main-Prozess. Foldwing läuft auf Windows
 * und Linux – alles Plattform-Spezifische (Registry, XDG-Dateien, Scanner,
 * cloudflared-Binärname) entscheidet sich über diese Helfer statt über
 * verstreute `process.platform`-Abfragen.
 */
import { homedir } from 'os'
import { join } from 'path'

export const isWindows = process.platform === 'win32'
export const isLinux = process.platform === 'linux'

/**
 * Stabiler Pfad zur ausführbaren App – für Autostart-Einträge und das
 * „Mit Foldwing teilen"-Kontextmenü. Bei einem AppImage zeigt process.execPath
 * auf den flüchtigen Mount-Ordner (/tmp/.mount_…); stabil ist nur der Pfad der
 * AppImage-Datei selbst (Umgebungsvariable APPIMAGE).
 */
export function stableExePath(): string {
  return process.env['APPIMAGE'] || process.execPath
}

/**
 * Ist die App „richtig" installiert (stabiler Pfad)? Nur dann dürfen wir uns in
 * Autostart/Kontextmenü eintragen – ein entpackter Test-Build (linux-unpacked)
 * würde sonst Einträge hinterlassen, die nach dem Aufräumen ins Leere zeigen.
 */
export function hasStableInstallPathLinux(): boolean {
  if (process.env['APPIMAGE']) return true
  return process.execPath.startsWith('/opt/') || process.execPath.startsWith('/usr/')
}

/**
 * Art der grafischen Sitzung aus den Umgebungsvariablen – rein, damit testbar.
 * XDG_SESSION_TYPE (von logind/Anmeldemanager gesetzt) zählt zuerst. Fehlt er,
 * entscheiden DISPLAY/WAYLAND_DISPLAY; sind beide gesetzt (z. B. WSLg oder eine
 * verschachtelte Sitzung), bleibt es 'unknown'.
 */
export function sessionKind(env: Record<string, string | undefined>): 'x11' | 'wayland' | 'unknown' {
  const type = (env['XDG_SESSION_TYPE'] || '').toLowerCase()
  if (type === 'x11') return 'x11'
  if (type === 'wayland') return 'wayland'
  const x = !!env['DISPLAY']
  const w = !!env['WAYLAND_DISPLAY']
  if (x && !w) return 'x11'
  if (w && !x) return 'wayland'
  return 'unknown'
}

/** X11-Sitzung? (Fenster-Erkennung für Screenshots gibt es nur dort.) */
export function isX11Session(): boolean {
  return isLinux && sessionKind(process.env) === 'x11'
}

/**
 * Wayland-Sitzung? Dort kommen systemweite Tastenkürzel nicht bei uns an, und ein
 * Bildschirmfoto über XWayland bleibt schwarz – die Screenshot-Funktion ist dann aus.
 */
export function isWaylandSession(): boolean {
  return isLinux && sessionKind(process.env) === 'wayland'
}

/** XDG-Konfigordner (~/.config bzw. $XDG_CONFIG_HOME). */
export function xdgConfigHome(): string {
  return process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config')
}

/** XDG-Datenordner (~/.local/share bzw. $XDG_DATA_HOME). */
export function xdgDataHome(): string {
  return process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share')
}

/**
 * Einen Wert für die Exec-Zeile einer .desktop-Datei absichern (Desktop Entry
 * Spec): erst die Exec-eigenen Sonderzeichen per Backslash schützen, dann in
 * doppelte Anführungszeichen setzen. So funktionieren auch Pfade mit
 * Leerzeichen und Sonderzeichen.
 */
export function desktopExecQuote(path: string): string {
  const escaped = path.replace(/[\\"`$]/g, (c) => '\\' + c)
  return `"${escaped}"`
}
