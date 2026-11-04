import { spawn } from 'child_process'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'fs'
import { delimiter, join } from 'path'
import { isWindows } from './platform'

/**
 * Schadsoftware-Prüfung über den auf dem System vorhandenen Scanner:
 * Windows Defender (MpCmdRun) unter Windows, ClamAV (clamdscan/clamscan) unter
 * Linux. Läuft komplett lokal – keine Datei verlässt den Rechner. Erkennt
 * Malware inhaltlich statt nach Dateityp, damit harmlose Privatprojekte
 * (.exe u. Ä.) weiterhin geteilt werden können.
 */
export type ScanResult = 'clean' | 'infected' | 'unavailable'

/** Kommando samt Deutung der Exit-Codes – je Scanner verschieden. */
export interface ScanCommand {
  bin: string
  args: (path: string) => string[]
  /** Exit-Code, der einen Fund bedeutet (alles andere außer „sauber" = unavailable). */
  infectedCode: number
  /** Exit-Code für „kein Fund". */
  cleanCode: number
}

/** MpCmdRun.exe finden (neueste Platform-Version bevorzugt). */
export function findDefender(): string | null {
  try {
    const platform = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform'
    if (existsSync(platform)) {
      const versions = readdirSync(platform).sort().reverse()
      for (const v of versions) {
        const p = join(platform, v, 'MpCmdRun.exe')
        if (existsSync(p)) return p
      }
    }
  } catch {
    /* weiter mit Legacy-Pfad */
  }
  const legacy = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe'
  return existsSync(legacy) ? legacy : null
}

/** Prüft, ob ein Kandidatenpfad eine tatsächlich nutzbare Datei ist (nicht nur vorhanden). */
function isUsableFile(c: string): boolean {
  if (!existsSync(c)) return false
  try {
    if (!statSync(c).isFile()) return false
  } catch {
    return false
  }
  // Unter Linux zusätzlich das Ausführungsrecht prüfen – ein Treffer ohne
  // x-Bit (z. B. kaputte Installation) würde sonst später beim spawn scheitern.
  if (!isWindows) {
    try {
      accessSync(c, constants.X_OK)
    } catch {
      return false
    }
  }
  return true
}

/** Ein Programm in Standardpfaden und im PATH suchen (Linux). */
function findInPath(name: string): string | null {
  const candidates = [`/usr/bin/${name}`, `/usr/local/bin/${name}`]
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.trim()) candidates.push(join(dir.trim(), name))
  }
  for (const c of candidates) {
    if (isUsableFile(c)) return c
  }
  return null
}

/**
 * Passenden Scanner fürs System finden. Linux: clamdscan bevorzugt (nutzt den
 * laufenden ClamAV-Dienst, Millisekunden statt Sekunden – --fdpass, damit der
 * Dienst auch Dateien lesen darf, die nur dem Nutzer gehören), sonst clamscan.
 */
export function findScanCommand(): ScanCommand | null {
  if (isWindows) {
    const bin = findDefender()
    if (!bin) return null
    return {
      bin,
      // -DisableRemediation: nur erkennen, nicht in Quarantäne schieben –
      // gelöscht wird die Freigabe anschließend von uns selbst.
      args: (path) => ['-Scan', '-ScanType', '3', '-File', path, '-DisableRemediation'],
      cleanCode: 0, // MpCmdRun: 0 = kein Fund, 2 = Fund
      infectedCode: 2
    }
  }
  const clamd = findInPath('clamdscan')
  if (clamd) {
    return {
      bin: clamd,
      args: (path) => ['--no-summary', '--fdpass', '--', path],
      cleanCode: 0, // clamscan/clamdscan: 0 = kein Fund, 1 = Fund, 2 = Fehler
      infectedCode: 1
    }
  }
  const clam = findInPath('clamscan')
  if (clam) {
    return {
      bin: clam,
      args: (path) => ['--no-summary', '--', path],
      cleanCode: 0,
      infectedCode: 1
    }
  }
  return null
}

/**
 * Datei scannen. "unavailable" (kein Scanner / Timeout / Fehler) lässt den
 * Upload bewusst durch (fail-open) – sonst wäre Teilen auf Systemen ohne
 * Scanner unmöglich; die Normalfälle (Windows Defender, ClamAV) sind abgedeckt.
 */
export function scanFile(
  path: string,
  timeoutMs = 300_000,
  cmdOverride?: ScanCommand
): Promise<ScanResult> {
  return new Promise((resolve) => {
    const cmd = cmdOverride ?? findScanCommand()
    if (!cmd) return resolve('unavailable')

    let child
    try {
      child = spawn(cmd.bin, cmd.args(path), { windowsHide: true })
    } catch {
      return resolve('unavailable')
    }

    const timer = setTimeout(() => {
      child.kill()
      resolve('unavailable')
    }, timeoutMs)

    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === cmd.infectedCode ? 'infected' : code === cmd.cleanCode ? 'clean' : 'unavailable')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve('unavailable')
    })
  })
}
