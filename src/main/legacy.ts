/**
 * Umzug von „FlowShare“ (bis 1.3.x) zu „Foldwing“ (ab 1.4.0).
 *
 * Die App hieß früher FlowShare. Ein Update darf weder Einstellungen noch
 * Freigaben verlieren und keine toten Einträge im System zurücklassen. Alles,
 * was dafür den alten Namen kennen muss, steht hier gesammelt – an anderer
 * Stelle im Code taucht der alte Name nicht mehr auf.
 */
import { spawn } from 'child_process'
import { existsSync, renameSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'

/** Ordnernamen des alten Datenordners (Windows ist es egal, Linux unterscheidet). */
export const LEGACY_DATA_DIRS = ['FlowShare', 'flowshare']
/** Alte Config-Datei im Datenordner. */
export const LEGACY_CONFIG_FILE = 'flowshare-config.json'
/** Alter Ordner für Screenshots unter „Bilder“. */
export const LEGACY_PICTURES_DIR = 'FlowShare'

/**
 * Welchen Datenordner soll die App nehmen? Gibt es den neuen noch nicht, aber
 * einen alten, wird der alte umbenannt. Klappt das nicht (z. B. weil eine alte
 * Instanz noch läuft und Dateien sperrt), bleibt die App beim alten Ordner –
 * lieber ein alter Name auf der Platte als verlorene Freigaben.
 */
export function resolveDataDir(
  appDataDir: string,
  newDir: string,
  fs: { exists: (p: string) => boolean; rename: (a: string, b: string) => void } = {
    exists: existsSync,
    rename: renameSync
  }
): string {
  if (fs.exists(newDir)) return newDir
  for (const name of LEGACY_DATA_DIRS) {
    const old = join(appDataDir, name)
    if (old === newDir || !fs.exists(old)) continue
    try {
      fs.rename(old, newDir)
      return newDir
    } catch {
      return old
    }
  }
  return newDir
}

/** Alte Config-Datei auf den neuen Namen bringen, falls die neue noch fehlt. */
export function migrateConfigFile(
  dataDir: string,
  newFile: string,
  fs: { exists: (p: string) => boolean; rename: (a: string, b: string) => void } = {
    exists: existsSync,
    rename: renameSync
  }
): void {
  const newPath = join(dataDir, newFile)
  const oldPath = join(dataDir, LEGACY_CONFIG_FILE)
  if (fs.exists(newPath) || !fs.exists(oldPath)) return
  try {
    fs.rename(oldPath, newPath)
  } catch {
    /* bleibt liegen; die App startet dann mit Standardwerten */
  }
}

/**
 * Standardordner für Screenshots: Hat jemand schon Aufnahmen unter dem alten
 * Namen und noch keinen neuen Ordner, bleibt es beim alten – dort liegen seine
 * Bilder, und die Einstellungen zeigen genau diesen Pfad an.
 */
export function defaultPicturesDir(
  picturesDir: string,
  newName: string,
  exists: (p: string) => boolean = existsSync
): string {
  const neu = join(picturesDir, newName)
  const alt = join(picturesDir, LEGACY_PICTURES_DIR)
  if (!exists(neu) && exists(alt)) return alt
  return neu
}

/** Registry-Reste der alten Installation (Windows, nur aktueller Benutzer). */
export const LEGACY_WINDOWS_KEYS = ['HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\FlowShare']
export const LEGACY_WINDOWS_VALUES: { key: string; value: string }[] = [
  { key: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', value: 'electron.app.FlowShare' },
  {
    key: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
    value: 'electron.app.FlowShare'
  }
]

function runReg(regExe: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(regExe, args, { windowsHide: true })
    p.on('error', () => resolve())
    p.on('exit', () => resolve())
  })
}

/**
 * Alten Rechtsklick-Eintrag und alten Autostart-Eintrag entfernen. Der alte
 * Autostart zeigt nach dem Update auf eine Exe, die es nicht mehr gibt.
 * Fehlende Einträge sind kein Fehler.
 */
export async function removeLegacyWindowsEntries(regExe: string): Promise<void> {
  for (const key of LEGACY_WINDOWS_KEYS) await runReg(regExe, ['delete', key, '/f'])
  for (const { key, value } of LEGACY_WINDOWS_VALUES) {
    await runReg(regExe, ['delete', key, '/v', value, '/f'])
  }
}

/** Alte Desktop-Dateien unter Linux (Rechtsklick, Autostart, Icon, Nautilus-Skript). */
export function legacyLinuxFiles(dataHome: string, configHome: string): string[] {
  return [
    join(dataHome, 'applications', 'flowshare-share.desktop'),
    join(dataHome, 'icons', 'flowshare.png'),
    join(dataHome, 'nautilus', 'scripts', 'Mit FlowShare teilen'),
    join(configHome, 'autostart', 'flowshare.desktop')
  ]
}

export async function removeLegacyLinuxFiles(dataHome: string, configHome: string): Promise<void> {
  for (const f of legacyLinuxFiles(dataHome, configHome)) {
    await rm(f, { force: true }).catch(() => {})
  }
}
