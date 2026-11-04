/**
 * Welche Art von Update passt zu diesem Build? Rein und elektronfrei (getestet in
 * tests/update-mode.test.ts).
 *
 *  - 'auto':   Windows-Installer (NSIS) und AppImage – electron-updater lädt und
 *              installiert selbst.
 *  - 'manual': Portable-Exe und .deb – nur der Hinweis „Neue Version verfügbar“
 *              mit Link auf die Releases-Seite.
 *  - 'none':   Dev-Läufe und entpackte Test-Builds (release/win-unpacked) prüfen nie.
 */
export type UpdateMode = 'auto' | 'manual' | 'none'

export const RELEASES_URL = 'https://github.com/FynnXland/foldwing/releases'

export interface UpdateModeInput {
  platform: string
  packaged: boolean
  /** Windows: echte Installation (Deinstallierer neben der Exe, nicht portabel). */
  installed: boolean
  env: Record<string, string | undefined>
  execPath: string
}

export function decideUpdateMode(i: UpdateModeInput): UpdateMode {
  if (!i.packaged) return 'none'
  if (i.platform === 'win32') {
    if (i.env['PORTABLE_EXECUTABLE_DIR']) return 'manual'
    return i.installed ? 'auto' : 'none'
  }
  if (i.platform === 'linux') {
    if (i.env['APPIMAGE']) return 'auto'
    // .deb landet unter /opt; ein entpacktes linux-unpacked liegt woanders.
    return i.execPath.startsWith('/opt/') || i.execPath.startsWith('/usr/') ? 'manual' : 'none'
  }
  return 'none'
}
