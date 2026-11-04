// Nur der Typ – electron-updater selbst wird erst beim ersten Gebrauch geladen (loadUpdater).
import type { AppUpdater } from 'electron-updater'
import type { UpdateMode } from './update-mode'

const CHECK_INTERVAL = 6 * 3_600_000 // alle 6 Stunden
const FIRST_CHECK_DELAY = 20_000 // nicht mitten in den Start hinein prüfen

/** Für die Oberfläche aufbereiteter Update-Zustand. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  /** Portable/.deb: neue Version da, Installation von Hand über die Releases-Seite. */
  | { state: 'manual'; version: string }
  | { state: 'none' }
  | { state: 'error'; message: string }
  /** Dev-Lauf oder entpackter Test-Build – es wird nie geprüft. */
  | { state: 'disabled' }

let mode: UpdateMode = 'none'
let autoCheckEnabled = true
let lastStatus: UpdateStatus = { state: 'idle' }
let emit: (s: UpdateStatus) => void = () => {}
// Handles der Timer, damit disposeAutoUpdater sie beim Beenden räumen kann.
let firstCheckTimer: ReturnType<typeof setTimeout> | null = null
let intervalTimer: ReturnType<typeof setInterval> | null = null
// electron-updater (~8–13 MB im Hauptprozess) erst laden, wenn wirklich geprüft wird.
// Einmal geladen und eingerichtet, bleibt die Instanz; `loadedUpdater` erlaubt den
// synchronen Zugriff in quitAndInstall.
let updaterLoading: Promise<AppUpdater> | null = null
let loadedUpdater: AppUpdater | null = null

function set(s: UpdateStatus): void {
  lastStatus = s
  emit(s)
}

/** Nur eine kurze Meldung – Fehlertexte von electron-updater enthalten sonst ganze Antworten. */
function errorText(e: unknown): string {
  const msg = String((e as { message?: unknown } | null | undefined)?.message || e || 'Unbekannter Fehler')
  return msg.split('\n')[0].slice(0, 160)
}

export function getUpdateStatus(): UpdateStatus {
  return lastStatus
}

export function getUpdateMode(): UpdateMode {
  return mode
}

/**
 * electron-updater laden und einmalig einrichten. Die Quelle (GitHub-Releases von
 * FynnXland/foldwing) steht über `build.publish` in package.json in der
 * app-update.yml des Builds. CommonJS -> unter ESM liegt die API auf `default`
 * (CLAUDE.md §6). Schlägt das Laden fehl, versucht es der nächste Gebrauch neu.
 */
function loadUpdater(): Promise<AppUpdater> {
  updaterLoading ??= import('electron-updater')
    .then((mod) => {
      const { autoUpdater } = mod.default ?? mod
      // Portable/.deb: nur nachsehen, nie selbst herunterladen.
      autoUpdater.autoDownload = mode === 'auto'
      autoUpdater.autoInstallOnAppQuit = mode === 'auto'
      autoUpdater.logger = null

      autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
      autoUpdater.on('update-available', (info) =>
        set(mode === 'auto' ? { state: 'available', version: info.version } : { state: 'manual', version: info.version })
      )
      autoUpdater.on('update-not-available', () => set({ state: 'none' }))
      autoUpdater.on('download-progress', (p) =>
        set({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent))) })
      )
      autoUpdater.on('update-downloaded', (info) => set({ state: 'downloaded', version: info.version }))
      autoUpdater.on('error', (e) => set({ state: 'error', message: errorText(e) }))

      loadedUpdater = autoUpdater
      return autoUpdater
    })
    .catch((e: unknown) => {
      updaterLoading = null
      throw e
    })
  return updaterLoading
}

/**
 * Updates einrichten. `updateMode` aus update-mode.ts; `auto` ist die Einstellung
 * „Automatisch nach Updates suchen“. Synchron und wirft nicht: hier werden nur
 * Timer gestellt, erst die erste Prüfung lädt electron-updater.
 */
export function initAutoUpdater(
  updateMode: UpdateMode,
  auto: boolean,
  onStatus: (s: UpdateStatus) => void
): void {
  emit = onStatus
  mode = updateMode
  if (mode === 'none') {
    set({ state: 'disabled' })
    return
  }
  setAutoCheck(auto)
}

/** Einstellung „Automatisch nach Updates suchen“ übernehmen (auch zur Laufzeit). */
export function setAutoCheck(auto: boolean): void {
  autoCheckEnabled = auto
  disposeAutoUpdater()
  if (mode === 'none' || !autoCheckEnabled) return
  firstCheckTimer = setTimeout(() => void autoCheck(), FIRST_CHECK_DELAY)
  intervalTimer = setInterval(() => void autoCheck(), CHECK_INTERVAL)
}

/** Automatische Prüfung im Hintergrund – lehnt nie ab. */
async function autoCheck(): Promise<void> {
  // Ein fertig geladenes oder gemeldetes Update nicht durch neue Prüfungen überschreiben.
  if (lastStatus.state === 'downloaded' || lastStatus.state === 'downloading') return
  let updater: AppUpdater
  try {
    updater = await loadUpdater()
  } catch (e) {
    set({ state: 'error', message: errorText(e) })
    return
  }
  try {
    await updater.checkForUpdates()
  } catch {
    /* Prüf-Fehler meldet der error-Handler */
  }
}

/** Timer der automatischen Prüfung räumen (z. B. beim App-Beenden). Idempotent. */
export function disposeAutoUpdater(): void {
  if (firstCheckTimer) {
    clearTimeout(firstCheckTimer)
    firstCheckTimer = null
  }
  if (intervalTimer) {
    clearInterval(intervalTimer)
    intervalTimer = null
  }
}

/** Manuelle Prüfung (vom „Nach Updates suchen“-Knopf). Status „checking“ sofort, Rest async. */
export function checkForUpdatesNow(): void {
  if (mode === 'none') {
    set({ state: 'disabled' })
    return
  }
  if (lastStatus.state === 'downloaded') return
  set({ state: 'checking' })
  void loadUpdater()
    .then((updater) => updater.checkForUpdates())
    .catch((e: unknown) => set({ state: 'error', message: errorText(e) }))
}

/**
 * Heruntergeladenes Update sofort installieren (App startet dabei neu).
 * Liefert true, wenn quitAndInstall erfolgreich angestoßen wurde, sonst false –
 * der Aufrufer kann dann z. B. sein `isQuitting`-Flag zurücksetzen.
 */
export function quitAndInstallUpdate(): boolean {
  if (mode !== 'auto' || lastStatus.state !== 'downloaded' || !loadedUpdater) return false
  try {
    // isSilent=false (Installer sichtbar), isForceRunAfter=true (App danach wieder starten)
    loadedUpdater.quitAndInstall(false, true)
    return true
  } catch {
    return false
  }
}
