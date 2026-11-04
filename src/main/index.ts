import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  dialog,
  clipboard,
  Notification,
  screen,
  safeStorage,
  type Rectangle
} from 'electron'
import { join, basename, dirname } from 'path'
import { appendFileSync, createReadStream, existsSync, promises as fsp } from 'fs'
import {
  isWindows,
  isLinux,
  stableExePath,
  hasStableInstallPathLinux,
  xdgConfigHome,
  xdgDataHome,
  desktopExecQuote
} from './platform'
import {
  registerShareContextMenu,
  isShareContextMenuRegistered,
  extractSharePath,
  mimeFromName,
  regExePath
} from './context-menu'
import { ShareStore, ShareMeta } from './store'
import { startServer, clearPreviewCache, ServerHandle, ServerHooks } from './server'
import { scanFile, findScanCommand } from './scanner'
import {
  initCapture,
  updateHotkey,
  disposeCapture,
  isHotkeyActive,
  captureUnavailableReason
} from './capture'
import { ConfigStore, CONFIG_FILE, detectLanAddress, CaptureConfig, type AppConfig, type LinkMode } from './config'
import { TunnelManager, type TunnelRunOptions, type TunnelState } from './tunnel'
import {
  decideSharing,
  countActiveShares,
  trayTooltip,
  describeLinkStatus,
  HOLD_MS,
  type LinkStatus
} from './sharing-policy'
import {
  RelayClient,
  relayBaseUrl,
  relayShareUrl,
  makeDeviceId,
  makeSecret,
  encodeSecret,
  decodeSecret,
  DEVICE_ID_RE,
  RELAY_INFO_PATH,
  RELAY_RULES_PATH,
  RELAY_PRIVACY_PATH,
  RELAY_IMPRINT_PATH,
  type RelayIdentity
} from './relay'
import { normalizeBaseUrl } from './links'
import { decideUpdateMode, RELEASES_URL } from './update-mode'
import {
  initAutoUpdater,
  getUpdateStatus,
  getUpdateMode,
  checkForUpdatesNow,
  quitAndInstallUpdate,
  disposeAutoUpdater,
  setAutoCheck,
  type UpdateStatus
} from './updater'
import { APP_NAME } from './brand'
import {
  resolveDataDir,
  migrateConfigFile,
  removeLegacyWindowsEntries,
  removeLegacyLinuxFiles
} from './legacy'

// ---- Start-Messung (nur mit FOLDWING_TRACE_STARTUP=1) ----------------------
// Schreibt Zeitmarken (ms seit Prozessstart) nach <userData>/startup-trace.txt –
// damit lässt sich in der gepackten App sehen, wo beim Start die Zeit hingeht.
const TRACE_STARTUP = !!process.env['FOLDWING_TRACE_STARTUP']
function trace(label: string): void {
  if (!TRACE_STARTUP) return
  try {
    appendFileSync(
      join(app.getPath('userData'), 'startup-trace.txt'),
      `${label}\t${Math.round(performance.now())}\n`
    )
  } catch {
    /* nur Diagnose */
  }
}
trace('main-module')

let store: ShareStore
let config: ConfigStore
let serverHandle: ServerHandle | null = null
/** Schnittstelle, auf der der Server lauscht (undefined = alle). */
let serverHost: string | undefined
let tunnel: TunnelManager
let relay: RelayClient
let tray: Tray | null = null
let isQuitting = false
// Explizite Referenz aufs Hauptfenster. WICHTIG: nie über getAllWindows()[0] raten –
// die Liste enthält auch die unsichtbaren Screenshot-Overlay-Fenster (Pool), und die
// Reihenfolge ist nicht garantiert. Wer das falsche Fenster „zeigt", präsentiert dem
// Nutzer ein graues Aufnahme-Overlay mit Fadenkreuz statt der App.
let mainWin: BrowserWindow | null = null
// Maße beim letzten Schließen – das neu angelegte Fenster geht genauso wieder auf.
let lastWindowState: { bounds: Rectangle; maximized: boolean } | null = null
// Nur versteckt statt freigegeben, weil beim Schließen noch ein Upload lief.
let parkedWin: BrowserWindow | null = null

// Teilen nach Bedarf (Regel in sharing-policy.ts): seit wann es nichts mehr zu
// teilen gibt, bis wann festgehalten wird, und wie viele Links gerade gelten.
let idleSince: number | null = null
let holdUntil = 0
let activeShareCount = 0

// Wiederkehrende Timer als Modulvariablen, damit der Beenden-Pfad sie sicher räumt
// (sonst hält ein laufendes Intervall den Prozess am Leben oder greift auf schon
// abgeräumte Objekte zu).
let sweepTimer: ReturnType<typeof setInterval> | null = null
let recheckTimer: ReturnType<typeof setTimeout> | null = null
let parkTimer: ReturnType<typeof setInterval> | null = null
let deferredTimer: ReturnType<typeof setTimeout> | null = null
// Wächter gegen Rekursion im before-quit-Handler (siehe unten).
let shutdownStarted = false

/** Läuft die App schon so weit, dass Anfragen von außen bedient werden können? */
let appIsReady = false
// Zweitstarts, die eintreffen, BEVOR Store/Config/Fenster stehen. Ohne diese
// Warteschlange griff der Handler auf noch undefinierte Objekte zu (Absturz).
let pendingSharePaths: string[] = []
let pendingShowWindow = false

/** Relay: Basis-URL (Standard foldwing.online; nur für Tests per Umgebung änderbar). */
const RELAY_BASE = relayBaseUrl()
const REPO_URL = 'https://github.com/FynnXland/foldwing'

/** Kurz warten, ohne den Prozess am Leben zu halten. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.())
}

/** Fehler aus „nebenher"-Promises sichtbar machen, ohne die App zu killen. */
function logError(where: string, e: unknown): void {
  // Bewusst nur die Meldung: Token/Geheimnisse dürfen nie in die Ausgabe geraten.
  console.error(`[Foldwing] ${where}: ${e instanceof Error ? e.message : String(e)}`)
}

// Letztes Netz: ein einzelner unbehandelter Fehler soll die App nicht killen und
// auch keinen Inhalt ausplaudern – nur eine knappe Zeile ins Log.
process.on('unhandledRejection', (reason) => logError('Unbehandelte Promise-Ablehnung', reason))
process.on('uncaughtException', (err) => logError('Unbehandelter Fehler', err))

/** Gepufferte Zweitstart-Wünsche abarbeiten, sobald die App bereit ist. */
async function drainPendingRequests(): Promise<void> {
  appIsReady = true
  const paths = pendingSharePaths
  pendingSharePaths = []
  if (pendingShowWindow) {
    pendingShowWindow = false
    showMainWindow()
  }
  for (const p of paths) await shareFileFromPath(p)
}

// Nur EINE Instanz. Ohne diese Sperre startete ein Doppelklick aufs Icon (während
// die App im Tray weiterlief) eine ZWEITE Instanz: kompletter Kaltstart statt
// Fenster-nach-vorn, doppelter Server, und der Einstellungs-Speicher (localStorage)
// war von der ersten Instanz gesperrt -> „alles zurückgesetzt" (Theme, Hinweise).
// Außerdem blockierte die Zweit-Instanz das Auto-Update (Programmdateien in Benutzung).
// Jetzt: Zweitstart übergibt an die laufende Instanz und beendet sich sofort; die
// laufende Instanz holt ihr Fenster nach vorn.
// Die App hieß bis 1.3.x „FlowShare“. Den alten Datenordner vor allem anderen
// übernehmen – auch die Sperre für die Einzel-Instanz liegt dort.
app.setPath('userData', resolveDataDir(app.getPath('appData'), app.getPath('userData')))
migrateConfigFile(app.getPath('userData'), CONFIG_FILE)

const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // Kam der Zweitstart über den Rechtsklick-Eintrag „Mit Foldwing teilen"?
    const shared = extractSharePath(argv)
    // Noch nicht hochgefahren? Wunsch merken statt auf undefinierte Objekte greifen.
    if (!appIsReady) {
      if (shared) pendingSharePaths.push(shared)
      else pendingShowWindow = true
      return
    }
    if (shared) void shareFileFromPath(shared).catch((e) => logError('Teilen aus Zweitstart', e))
    else showMainWindow()
  })
}

/** Obergrenze für Dateien in einer Sammel-Freigabe (Schutz vor Versehen). */
const MAX_BUNDLE_FILES = 100

/** Ohne Lebenszeichen so lange gilt ein Upload als verwaist (Fenster abgestürzt o. ä.). */
const STALE_UPLOAD_MS = 10 * 60_000

/** Standard-Ablaufzeitpunkt für neue Freigaben laut Einstellung. */
function defaultExpiresAt(): number | undefined {
  const h = config.get().defaultTtlHours
  return h > 0 ? Date.now() + h * 3_600_000 : undefined
}

/** Externe Links nur über http/https öffnen – keine anderen Protokolle. */
function safeOpenExternal(url: string): void {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url)
  } catch {
    /* keine gültige URL -> ignorieren */
  }
}

/** Hauptfenster zeigen – oder neu anlegen, wenn es (zum RAM-Sparen) freigegeben wurde. */
function showMainWindow(): void {
  if (mainWin && !mainWin.isDestroyed()) {
    unparkMainWindow() // wird wieder gebraucht -> nicht mehr freigeben
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
  } else {
    createWindow()
  }
}

/** Lage des Fensters merken – auch maximiert die normale Größe dahinter. */
function rememberWindowState(win: BrowserWindow): void {
  try {
    lastWindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
  } catch {
    /* Fenster schon weg -> alten Stand behalten */
  }
}

/** Liegt der Platz noch (gut greifbar) auf einem Bildschirm? Monitor evtl. abgesteckt. */
function isOnSomeScreen(b: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    return w >= 120 && h >= 60
  })
}

/**
 * Schließen während eines Uploads: Die Chunks kommen aus genau diesem Renderer,
 * er darf also noch nicht sterben. Fenster nur verstecken und freigeben, sobald
 * kein Upload mehr läuft (Upload-Enden melden sich, dazu ein Sicherheits-Intervall
 * für Uploads, die sich nicht melden).
 */
function parkMainWindow(win: BrowserWindow): void {
  win.hide()
  parkedWin = win
  if (!parkTimer) parkTimer = setInterval(releaseParkedWindow, 5_000)
}

function unparkMainWindow(): void {
  parkedWin = null
  if (parkTimer) {
    clearInterval(parkTimer)
    parkTimer = null
  }
}

/** Geparktes Fenster freigeben, sobald kein Upload mehr läuft. */
function releaseParkedWindow(): void {
  const win = parkedWin
  if (!win || win.isDestroyed()) return unparkMainWindow()
  if (store.hasPendingUploads()) return
  unparkMainWindow()
  win.destroy()
}

/**
 * Autostart beim Anmelden (per-user, keine Adminrechte): Windows über einen
 * Run-Eintrag, Linux über eine XDG-Autostart-Datei (~/.config/autostart). Beim
 * Systemstart bekommt die App `--autostart` und beginnt still im Infobereich, ganz
 * ohne Fenster – der Hotkey ist sofort da, Server und Tunnel laufen nur, wenn es
 * etwas zu teilen gibt.
 */
function applyAutostart(): void {
  if (!app.isPackaged) return // Dev-Läufe nicht in den Autostart hängen
  if (isWindows) applyAutostartWindows()
  else if (isLinux) applyAutostartLinux()
}

/**
 * Ist das die echte Installation? Unter Windows erkennbar am Deinstallierer neben
 * der Exe (nicht portable, kein entpackter Test-Build aus release/win-unpacked);
 * unter Linux am stabilen Installationspfad. Nur sie darf Autostart und Rechtsklick-
 * Eintrag anlegen – sonst kapert ein Test-Build beides, und nach dem nächsten
 * Neustart startet die falsche (oder gar keine) App.
 */
function isInstalledBuild(): boolean {
  if (!app.isPackaged) return false
  if (isWindows) {
    if (process.env['PORTABLE_EXECUTABLE_DIR']) return false
    return existsSync(join(dirname(process.execPath), 'Uninstall Foldwing.exe'))
  }
  if (isLinux) return hasStableInstallPathLinux()
  return false
}

function applyAutostartWindows(): void {
  if (!isInstalledBuild()) return
  try {
    app.setLoginItemSettings({
      openAtLogin: config.get().autostart,
      path: process.execPath,
      args: ['--autostart']
    })
  } catch {
    /* Registry nicht beschreibbar -> beim nächsten Start erneut */
  }
}

function applyAutostartLinux(): void {
  // Nur echte Installationen (deb unter /opt bzw. AppImage-Datei) – ein
  // entpackter Test-Build (linux-unpacked) hätte keinen stabilen Pfad.
  if (!hasStableInstallPathLinux()) return
  const file = join(xdgConfigHome(), 'autostart', 'foldwing.desktop')
  void (async () => {
    try {
      if (!config.get().autostart) {
        await fsp.rm(file, { force: true })
        return
      }
      const content =
        '[Desktop Entry]\n' +
        'Type=Application\n' +
        'Name=Foldwing\n' +
        'Comment=Datei-Sharing – startet still im Infobereich\n' +
        `Exec=${desktopExecQuote(stableExePath())} --autostart\n` +
        'Terminal=false\n' +
        'X-GNOME-Autostart-enabled=true\n'
      await fsp.mkdir(dirname(file), { recursive: true })
      await fsp.writeFile(file, content, 'utf8')
    } catch {
      /* Ordner nicht beschreibbar -> beim nächsten Start erneut */
    }
  })()
}

/** Wurde die App vom Autostart des Systems gestartet? Dann still im Tray beginnen. */
function startedByAutostart(): boolean {
  return process.argv.includes('--autostart')
}

/** Tray-Symbol anlegen/entfernen, je nach „im Hintergrund weiterlaufen"-Einstellung. */
function updateTray(): void {
  const want = config.get().closeToTray
  if (want && !tray) {
    const packaged = join(process.resourcesPath, 'icon.png')
    const dev = join(app.getAppPath(), 'build', 'icon.png')
    const iconPath = existsSync(packaged) ? packaged : dev
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    tray = new Tray(icon)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `${APP_NAME} öffnen`, click: showMainWindow },
        { type: 'separator' },
        {
          label: 'Beenden',
          click: () => {
            isQuitting = true
            app.quit()
          }
        }
      ])
    )
    tray.on('double-click', showMainWindow)
    // Linux-Tray (AppIndicator) kennt oft kein Doppelklick-Ereignis; Windows
    // öffnet auch beim einfachen Klick – wie die meisten Tray-Apps.
    tray.on('click', showMainWindow)
  } else if (!want && tray) {
    tray.destroy()
    tray = null
  }
  refreshTrayTooltip()
}

/** Tooltip des Infobereich-Symbols: echter Hotkey, gültige Links, ehrlicher Zustand. */
function refreshTrayTooltip(): void {
  if (!tray) return
  const cfg = config.get()
  tray.setToolTip(
    trayTooltip({
      hotkey: cfg.capture.hotkey,
      hotkeyActive: isHotkeyActive(),
      activeShares: activeShareCount,
      link: linkStatus().state,
      platform: process.platform
    })
  )
}

/** Ein Ereignis an alle lebenden Fenster schicken (ein Weg statt fünf Kopien). */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue
    try {
      w.webContents.send(channel, payload)
    } catch {
      /* Fenster verschwindet gerade -> egal */
    }
  }
}

// ---- Geräte-Identität für den Relay -------------------------------------------

let identityCache: RelayIdentity | null = null

/** Vorhandene Identität aus der Config lesen; null, wenn keine (lesbare) da ist. */
function loadIdentity(): RelayIdentity | null {
  const r = config.get().relay
  if (!DEVICE_ID_RE.test(r.deviceId) || !r.secretEnc) return null
  const secret = decodeSecret(r.secretEnc, safeStorage)
  return secret ? { deviceId: r.deviceId, secret } : null
}

/** Neue Geräte-ID samt Geheimnis anlegen und (verschlüsselt) speichern. */
function newIdentity(): RelayIdentity {
  const id = { deviceId: makeDeviceId(), secret: makeSecret() }
  identityCache = id
  // patch() setzt den Cache sofort, geschrieben wird im Hintergrund.
  void config
    .patch({
      relay: {
        ...config.get().relay,
        deviceId: id.deviceId,
        // Unter Linux kann der Schlüsselbund beim Autostart noch gesperrt sein. Ein
        // dann unlesbares Geheimnis würde eine neue Geräte-ID und damit neue Links
        // erzwingen. Dort deshalb als base64 ablegen (ehrlich als unverschlüsselt
        // markiert); die Config liegt ohnehin nur im eigenen Profil.
        secretEnc: encodeSecret(id.secret, isLinux ? null : safeStorage)
      }
    })
    .catch((e) => logError('Geräte-Kennung speichern', e))
  return id
}

/** Identität für den Relay – einmal pro Installation angelegt, dann wiederverwendet. */
function relayIdentity(): RelayIdentity {
  identityCache ??= loadIdentity() ?? newIdentity()
  return identityCache
}

/** Die ID war beim Relay vergeben (409): neue Identität, alle Links ändern sich. */
function renewIdentity(): RelayIdentity {
  const id = newIdentity()
  clearPreviewCache()
  void broadcastShareUrls().catch((e) => logError('Links aktualisieren', e))
  return id
}

/** Geräte-ID für Server und /api/health (ohne eine neue anzulegen). */
function currentDeviceId(): string | null {
  if (identityCache) return identityCache.deviceId
  const d = config.get().relay.deviceId
  return DEVICE_ID_RE.test(d) ? d : null
}

// ---- Links und ihr Zustand -----------------------------------------------------

/** Basis für LAN- und Domain-Links: konfigurierte Domain oder LAN-/localhost-Adresse. */
function lanOrDomainBase(): string {
  const cfg = config.get()
  if (cfg.linkMode === 'domain' && cfg.publicBaseUrl) return cfg.publicBaseUrl.replace(/\/+$/, '')
  const port = serverHandle?.port ?? cfg.port
  return `http://${detectLanAddress() ?? 'localhost'}:${port}`
}

/** Was die Oberfläche als Adresse der Links zeigt. */
function effectiveBaseUrl(): string {
  return config.get().linkMode === 'relay' ? RELAY_BASE : lanOrDomainBase()
}

function shareUrl(id: string): string {
  if (config.get().linkMode === 'relay') return relayShareUrl(RELAY_BASE, relayIdentity().deviceId, id)
  return `${lanOrDomainBase()}/s/${id}`
}

/** Zustand der Links für Kopfzeile, Banner, Einstellungen und Infobereich. */
function linkStatus(): LinkStatus {
  const cfg = config.get()
  return describeLinkStatus({
    mode: cfg.linkMode,
    running: !!serverHandle,
    tunnel: tunnel.getState(),
    relay: relay.getStatus(),
    domainReady: !!(cfg.publicBaseUrl && cfg.tunnel.token.trim()),
    lanAddress: detectLanAddress(),
    relayAccepted: cfg.relay.noticeAccepted
  })
}

function broadcastLinkStatus(): void {
  broadcast('link:status', linkStatus())
  refreshTrayTooltip()
}

/** Alle Links neu berechnen und der Oberfläche melden (Betriebsart oder Geräte-ID geändert). */
async function broadcastShareUrls(): Promise<void> {
  const list = await store.list()
  broadcast(
    'shares:urls',
    list.map((m) => ({ id: m.id, url: shareUrl(m.id) }))
  )
}

/** Einstellungen der Links, wie die Oberfläche sie braucht. Der Token selbst bleibt im Main. */
function linksSnapshot(): {
  mode: LinkMode
  publicBaseUrl: string
  hasToken: boolean
  relayBase: string
  relayInfoUrl: string
  relayRulesUrl: string
  relayPrivacyUrl: string
  relayAccepted: boolean
  deviceId: string | null
  effectiveBaseUrl: string
  status: LinkStatus
} {
  const cfg = config.get()
  return {
    mode: cfg.linkMode,
    publicBaseUrl: cfg.publicBaseUrl,
    hasToken: !!cfg.tunnel.token.trim(),
    relayBase: RELAY_BASE,
    relayInfoUrl: RELAY_BASE + RELAY_INFO_PATH,
    relayRulesUrl: RELAY_BASE + RELAY_RULES_PATH,
    relayPrivacyUrl: RELAY_BASE + RELAY_PRIVACY_PATH,
    relayAccepted: cfg.relay.noticeAccepted,
    deviceId: currentDeviceId(),
    effectiveBaseUrl: effectiveBaseUrl(),
    status: linkStatus()
  }
}

/** Zustand des Tunnels: im Relay-Modus geht die frische Adresse an die Anmeldung. */
function onTunnelState(state: TunnelState): void {
  if (config.get().linkMode === 'relay' && tunnel.runningMode() === 'quick') {
    if (state.status === 'connected' && state.url) relay.connect(state.url)
  }
  broadcastLinkStatus()
}

/** Pfad der eigenen, harmlosen cloudflared-Config für den Quick Tunnel (siehe tunnel.ts). */
function quickTunnelConfigPath(): string {
  return join(app.getPath('userData'), 'cloudflared-quick.yml')
}

/** Schon einmal gemeldet, dass der Relay-Hinweis auf eine Bestätigung wartet? */
let waitingNotified = false

/**
 * Welcher Tunnel passt zur Betriebsart? null = keiner (eigenes Netz, Domain
 * unvollständig, oder der Hinweis vor der ersten Relay-Anmeldung ist noch offen).
 */
function wantedTunnel(port: number): TunnelRunOptions | null {
  const cfg = config.get()
  if (cfg.linkMode === 'relay') {
    if (!cfg.relay.noticeAccepted) {
      // Ohne „Okay“ keine Anmeldung. Ist das Fenster gerade nicht zu sehen
      // (Screenshot oder Rechtsklick-Teilen aus dem Infobereich), einmal Bescheid geben.
      if (!waitingNotified && !(mainWin && !mainWin.isDestroyed() && mainWin.isVisible())) {
        waitingNotified = true
        notify('Dein Link wartet noch', `Öffne ${APP_NAME} und bestätige kurz den Hinweis, dann geht der Link los.`)
      }
      return null
    }
    return {
      mode: 'quick',
      port,
      configPath: quickTunnelConfigPath(),
      cloudflaredPath: cfg.tunnel.cloudflaredPath
    }
  }
  if (cfg.linkMode === 'domain' && cfg.publicBaseUrl && cfg.tunnel.token.trim()) {
    return { mode: 'token', token: cfg.tunnel.token, cloudflaredPath: cfg.tunnel.cloudflaredPath }
  }
  return null
}

// ---- Fenster -------------------------------------------------------------------

/** Farben der Fensterfläche je Thema – dieselben wie --bg-base in styles.css. */
function windowColors(dark: boolean): {
  bg: string
  bar: { color: string; symbolColor: string; height: number }
} {
  return dark
    ? { bg: '#0c0f13', bar: { color: '#151a20', symbolColor: '#eef1f5', height: 44 } }
    : { bg: '#f6f8fa', bar: { color: '#ffffff', symbolColor: '#151a20', height: 44 } }
}

function createWindow(): void {
  trace('create-window')
  // Fenster-Hintergrund + Titelleiste schon beim Erzeugen im zuletzt gewählten Theme.
  // Die Ladeanzeige in index.html ist durchsichtig, bis der Renderer das Thema
  // gesetzt hat – bis dahin sieht man genau diese Farbe, nie einen weißen Blitz.
  const { bg, bar } = windowColors(config.get().ui.theme === 'dark')

  // Wurde das Fenster schon einmal geschlossen (und freigegeben), dort weitermachen –
  // sofern der Platz noch auf einem Bildschirm liegt.
  const last = lastWindowState
  const place = last && isOnSomeScreen(last.bounds) ? last.bounds : null

  const win = new BrowserWindow({
    ...(place ?? { width: 1120, height: 740 }),
    minWidth: 820,
    minHeight: 560,
    // Fenster sofort zeigen: Es erscheint gleich in der Themenfarbe, die
    // Ladeanzeige aus index.html zeichnet sich darauf, sobald die Seite geparst
    // ist, und React ersetzt sie beim ersten Rendern. War es zuletzt maximiert,
    // zeigt es maximize() unten gleich in voller Größe (kein Umspringen).
    show: !last?.maximized,
    autoHideMenuBar: true,
    title: APP_NAME,
    backgroundColor: bg,
    // Eigene Titelleiste: kein grauer OS-Balken, die App-Kopfzeile übernimmt optisch
    // die volle Höhe. Die nativen Minimieren-/Maximieren-/Schließen-Schaltflächen
    // bleiben (Windows zeichnet sie in den unten gesetzten Farben) – nur der Rest
    // des Rahmens verschwindet. Farben werden vom Renderer bei Theme-Wechsel
    // aktuell gehalten (window:titleBarOverlay).
    titleBarStyle: 'hidden',
    titleBarOverlay: bar,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      // Rendern NICHT drosseln, wenn das Fenster (noch) nicht im Vordergrund/fokussiert
      // ist. Sonst pausiert Chromium beim Start das Zeichnen -> minutenlang leerer
      // (schwarzer) Schirm, bis das Fenster Fokus bekommt. So malt es sofort.
      backgroundThrottling: false,
      // Keine Rechtschreibprüfung: spart die Wörterbücher im Speicher, die App hat
      // ohnehin keine Freitextfelder, die sie bräuchten.
      spellcheck: false
    }
  })
  trace('window-constructed')
  if (last?.maximized) {
    win.maximize() // zeigt das Fenster gleich maximiert
  }
  // Aus dem Infobereich oder per Zweitstart geöffnet: nach vorn holen.
  win.focus()
  mainWin = win
  if (TRACE_STARTUP) {
    win.webContents.once('dom-ready', () => trace('renderer-dom-ready'))
    win.webContents.once('did-finish-load', () => trace('renderer-loaded'))
  }
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
    if (parkedWin === win) unparkMainWindow()
    // Direkt ans Schließen DIESES Fensters gebunden, nicht an window-all-closed:
    // Solange noch andere Fenster leben (z. B. Screenshot-Overlays aus capture.ts),
    // feuert window-all-closed nicht, wenn das Hauptfenster zugeht. Ohne „im
    // Hintergrund weiterlaufen" muss das Schließen die App trotzdem beenden.
    if (!config.get().closeToTray && process.platform !== 'darwin') app.quit()
  })
  win.on('show', () => {
    if (parkedWin === win) unparkMainWindow()
  })

  // „Im Hintergrund weiterlaufen": Schließen gibt das Fenster samt Renderer frei –
  // die App bleibt im Infobereich, der Screenshot-Hotkey aktiv. Beim nächsten
  // Öffnen entsteht es neu, mit denselben Maßen. Läuft noch ein Upload, wird es nur
  // geparkt (siehe parkMainWindow).
  win.on('close', (e) => {
    rememberWindowState(win)
    if (!config.get().closeToTray || isQuitting) return
    if (store.hasPendingUploads()) {
      e.preventDefault()
      parkMainWindow(win)
    }
  })

  win.webContents.setWindowOpenHandler((d) => {
    safeOpenExternal(d.url)
    return { action: 'deny' }
  })

  // Das Fenster darf seine eigene Oberfläche NIE verlassen. Sonst würde ein Link
  // (oder eine untergeschobene URL) eine fremde Seite mit unserer preload-Brücke
  // laden – die hätte dann Zugriff auf window.foldwing. Fremdes geht nach draußen
  // in den Systembrowser, und auch nur mit http/https.
  win.webContents.on('will-navigate', (e, url) => {
    if (isOwnRendererUrl(url)) return
    e.preventDefault()
    safeOpenExternal(url)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

/** Gehört die URL zur eigenen Renderer-Oberfläche (Dev-Server bzw. lokale Datei)? */
function isOwnRendererUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev) {
      const d = new URL(dev)
      // Dev-Server: gleiche Herkunft reicht (Vite lädt von dort auch neu).
      return u.origin === d.origin
    }
    if (u.protocol !== 'file:') return false
    // Pfade vergleichbar machen: Trennzeichen vereinheitlichen, führende Slashes
    // weg (file:///C:/… vs. C:\…), unter Windows zusätzlich Groß-/Kleinschreibung.
    const norm = (p: string): string => {
      const s = p.replace(/\\/g, '/').replace(/^\/+/, '')
      return isWindows ? s.toLowerCase() : s
    }
    return norm(decodeURIComponent(u.pathname)) === norm(join(import.meta.dirname, '../renderer/index.html'))
  } catch {
    return false
  }
}

app.whenReady().then(async () => {
  // Unterlegene Zweit-Instanz: nichts hochfahren, app.quit() ist schon unterwegs.
  if (!isPrimaryInstance) return
  trace('app-ready')

  // Vor dem Fenster nur, was es braucht: die Config (Thema, Infobereich) und die
  // IPC-Handler (der Renderer fragt das Thema synchron ab). Alles andere danach.
  config = new ConfigStore(app.getPath('userData'))
  await config.load()
  trace('config-loaded')
  store = new ShareStore(join(app.getPath('userData'), 'shares'))

  relay = new RelayClient({
    baseUrl: RELAY_BASE,
    version: app.getVersion(),
    fetch: (url, init) => fetch(url, init),
    identity: relayIdentity,
    renewIdentity,
    onStatus: () => broadcastLinkStatus()
  })
  tunnel = new TunnelManager(onTunnelState)
  registerIpc()

  // Beim Autostart ganz ohne Fenster beginnen: Auch versteckt kostet es einen
  // kompletten Renderer. Es entsteht erst, wenn es jemand sehen will (Infobereich,
  // Doppelklick, Zweitstart, Rechtsklick-Teilen). Ausnahme: Ist „im Hintergrund
  // weiterlaufen" aus, gibt es kein Tray-Symbol – ohne Fenster wäre die App dann
  // unsichtbar und nur über einen Zweitstart erreichbar.
  if (!startedByAutostart() || !config.get().closeToTray) createWindow()

  await store.init()
  trace('store-ready')

  updateTray()

  // Screenshot-Aufnahme (globaler Hotkey) starten.
  initCapture({
    captureConfig: () => config.get().capture,
    uploadScreenshot,
    onShareAdded: broadcastShareAdded
  })
  refreshTrayTooltip() // der Hotkey steht erst jetzt fest

  // Abgleichen, ob es etwas zu teilen gibt – nur dann starten Server und Tunnel.
  void reconcileSharing()

  // Wurde die App genau über den Rechtsklick-Eintrag mit einer Datei gestartet? Dann teilen.
  const initialShare = extractSharePath(process.argv)
  if (initialShare) void shareFileFromPath(initialShare).catch((e) => logError('Teilen beim Start', e))

  // Minütliche Pflege: Abgelaufenes löschen, verwaiste Uploads verwerfen, Teilen abgleichen.
  sweepTimer = setInterval(() => void sweepTick(), 60_000)

  app.on('activate', () => {
    // Nicht über getAllWindows zählen – die Overlay-Pool-Fenster zählen sonst mit.
    if (!mainWin || mainWin.isDestroyed()) createWindow()
  })

  // Ab jetzt darf ein Zweitstart bedient werden; Gepuffertes nachholen.
  await drainPendingRequests()

  // Was beim Start nicht eilt, kommt ein paar Sekunden später: Systemeinträge
  // (reg.exe bzw. Dateien) und die Update-Prüfung sollen dem ersten Bild nicht
  // die CPU wegnehmen.
  deferredTimer = setTimeout(() => {
    deferredTimer = null
    // Rechtsklick-Eintrag „Mit Foldwing teilen" sicherstellen (per-user, ohne Admin).
    void maybeRegisterContextMenu().catch((e) => logError('Kontextmenü registrieren', e))
    // Autostart-Eintrag mit der aktuellen Einstellung abgleichen.
    applyAutostart()
    // Updates: Installer und AppImage aktualisieren sich selbst, Portable und .deb
    // bekommen einen Hinweis, entpackte Test-Builds prüfen nie.
    initAutoUpdater(
      decideUpdateMode({
        platform: process.platform,
        packaged: app.isPackaged,
        installed: isInstalledBuild(),
        env: process.env,
        execPath: process.execPath
      }),
      config.get().updates.auto,
      (s) => broadcast('update:status', s)
    )
  }, 3_000)
}).catch((e) => logError('Start', e))

// Feuert, sobald das letzte Fenster zu ist – mit „im Hintergrund weiterlaufen" auch
// beim Freigeben des Hauptfensters. Ohne diesen Handler würde Electron dann die
// App beenden. Das eigentliche Beenden ohne Infobereich hängt am Hauptfenster
// selbst (win.on('closed') oben), weil andere Fenster dieses Ereignis aufhalten.
app.on('window-all-closed', () => {
  if (config?.get().closeToTray) return // im Tray weiterlaufen
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Alles Laufende geordnet abräumen: Hotkeys/Overlays, Update-Timer, eigene
 * Intervalle, Abmeldung beim Relay, cloudflared und zuletzt der HTTP-Server (der
 * noch offene Downloads zu Ende bringen darf, deshalb steht er hinten).
 */
async function shutdownAll(): Promise<void> {
  disposeCapture()
  disposeAutoUpdater()
  for (const t of [sweepTimer, parkTimer]) if (t) clearInterval(t)
  for (const t of [recheckTimer, deferredTimer]) if (t) clearTimeout(t)
  sweepTimer = recheckTimer = deferredTimer = null
  unparkMainWindow()
  // Erst abmelden (der Relay zeigt Besuchern dann gleich „nicht online“), dann
  // den Tunnel beenden. Höchstens 2 s – das Gesamt-Timeout unten bleibt das Netz.
  await relay?.disconnect(2_000).catch((e) => logError('Abmelden beim Relay', e))
  tunnel?.stop()
  await serverHandle?.close()
  serverHandle = null
}

// Beenden erst NACH dem Aufräumen. Vorher lief das asynchron ins Leere: cloudflared
// blieb als Waise zurück, der Server schloss nie sauber. Der Wächter `shutdownStarted`
// verhindert, dass der zweite (durchgelassene) Durchlauf wieder von vorn beginnt;
// ein Gesamt-Timeout von 3 s sorgt dafür, dass ein hängender Teil das Beenden nicht
// blockiert.
app.on('before-quit', (event) => {
  isQuitting = true
  // Die unterlegene Zweit-Instanz hat nichts hochgefahren – sie darf sofort raus.
  if (!isPrimaryInstance || shutdownStarted || !config) return
  shutdownStarted = true
  event.preventDefault()
  void (async () => {
    await Promise.race([shutdownAll().catch((e) => logError('Beenden', e)), delay(3000)])
    app.quit()
  })()
})

async function startEmbeddedServer(host: string | undefined): Promise<void> {
  const cfg = config.get()
  const hooks: ServerHooks = { deviceId: currentDeviceId }
  try {
    serverHandle = await startServer(store, cfg.port, hooks, host)
  } catch {
    // Port belegt -> vom System einen freien wählen lassen.
    serverHandle = await startServer(store, 0, hooks, host)
  }
  serverHost = host
}

/** Serverstatus in einer Form, die Abfrage und Broadcast gleichermaßen nutzen. */
function serverInfo(): {
  running: boolean
  port: number
  linkMode: LinkMode
  effectiveBaseUrl: string
  lan: string | null
} {
  return {
    running: !!serverHandle,
    port: serverHandle?.port ?? config.get().port,
    linkMode: config.get().linkMode,
    effectiveBaseUrl: effectiveBaseUrl(),
    lan: detectLanAddress()
  }
}

/** Aktuellen Serverstatus an alle Fenster melden (z. B. nach Stopp/Neustart). */
function broadcastServerInfo(): void {
  broadcast('server:changed', serverInfo())
  broadcastLinkStatus()
}

// Serialisiert Start/Stopp, damit sich schnell aufeinander folgende Anlässe
// (Upload beginnt, Freigabe gelöscht, Minuten-Takt …) nicht überholen.
let serverTransition: Promise<void> = Promise.resolve()

/**
 * Den nächsten Schritt an die Kette hängen. Fehler werden hier geschluckt und
 * geloggt – sonst bliebe die Kette dauerhaft „rejected" und JEDES spätere
 * Starten/Stoppen des Servers scheiterte still mit.
 */
function queueServerStep(step: () => Promise<void>, where: string): Promise<void> {
  serverTransition = serverTransition.then(step).catch((e) => logError(where, e))
  return serverTransition
}

/** Server und – je nach Betriebsart – den Tunnel hochfahren. Mehrfach aufrufbar. */
async function startSharing(): Promise<void> {
  const relayMode = config.get().linkMode === 'relay'
  // Im Relay-Modus holt nur cloudflared lokal ab – dann lauscht der Server auch
  // nur auf 127.0.0.1. Im eigenen Netz und mit eigener Domain auf allen Adressen.
  const host = relayMode ? '127.0.0.1' : undefined
  if (serverHandle && serverHost !== host) await stopSharing() // Betriebsart gewechselt
  if (!serverHandle) {
    if (relayMode) relayIdentity() // /api/health muss die Geräte-ID schon kennen
    await startEmbeddedServer(host)
    broadcastServerInfo()
  }
  if (isQuitting || !serverHandle) return // Beenden kam dazwischen -> keinen Tunnel mehr starten
  const want = wantedTunnel(serverHandle.port)
  const running = tunnel.runningMode()
  if (!want) {
    if (running) {
      await relay.disconnect()
      tunnel.stop()
    }
    return
  }
  if (running !== want.mode) {
    if (running) await relay.disconnect()
    tunnel.start(want)
  }
}

/** Abmelden, Tunnel und Server schlafen legen. Mehrfach aufrufbar. */
async function stopSharing(): Promise<void> {
  await relay.disconnect()
  if (tunnel.runningMode() || tunnel.getState().status !== 'off') tunnel.stop()
  const handle = serverHandle
  if (!handle) return
  serverHandle = null
  const closed = handle.close()
  // Was jetzt noch an Verbindungen offen ist, gehört zu nichts Geteiltem mehr
  // (gelöscht oder abgelaufen): kappen, damit der Port sofort frei ist und die
  // Kette nicht an einem langen Download hängen bleibt.
  handle.server.closeAllConnections()
  await Promise.race([closed, delay(2000)])
  // Zwischengespeicherte Vorschauen gehören zu Freigaben, die es nicht mehr gibt.
  clearPreviewCache()
  broadcastServerInfo()
}

/**
 * Teilen an die Lage anpassen: Server und Tunnel laufen genau dann, wenn es etwas
 * zu teilen gibt (Regel und Schonfrist in sharing-policy.ts). Die Sichtbarkeit des
 * Fensters spielt keine Rolle. Läuft über die serialisierte Kette.
 */
function reconcileSharing(): Promise<void> {
  return queueServerStep(async () => {
    if (isQuitting) return
    const now = Date.now()
    const expiries = (await store.list()).map((m) => m.expiresAt)
    const decision = decideSharing({
      now,
      shareExpiries: expiries,
      uploading: store.hasPendingUploads(),
      holdUntil,
      running: !!serverHandle,
      idleSince
    })
    idleSince = decision.idleSince
    activeShareCount = countActiveShares(expiries, now)
    try {
      if (decision.action === 'run') await startSharing()
      else if (decision.action === 'stop') await stopSharing()
      // 'wait': Schonfrist läuft – weiterlaufen und zum Ende hin neu entscheiden.
    } finally {
      scheduleRecheck(decision.recheckAt)
      refreshTrayTooltip()
    }
  }, 'Teilen abgleichen')
}

/** Zum angegebenen Zeitpunkt neu abgleichen (Ablauf, Ende des Festhaltens, Schonfrist). */
function scheduleRecheck(at: number | null): void {
  if (recheckTimer) {
    clearTimeout(recheckTimer)
    recheckTimer = null
  }
  if (at === null || isQuitting) return
  // Weit entfernte Zeitpunkte deckt der Minuten-Takt ab (setTimeout kann ohnehin
  // nur knapp 25 Tage); die kleine Zugabe sorgt dafür, dass die Frist sicher um ist.
  const ms = Math.min(Math.max(0, at - Date.now()) + 50, 3_600_000)
  recheckTimer = setTimeout(() => {
    recheckTimer = null
    void reconcileSharing()
  }, ms)
}

/** Teilen eine Weile festhalten, auch ohne Freigabe – damit man sieht, ob die Verbindung steht. */
function holdSharing(ms: number): void {
  holdUntil = Math.max(holdUntil, Date.now() + ms)
}

/**
 * Nach einem Wechsel der Betriebsart (oder von Domain/Token): alles Laufende
 * beenden, der Abgleich danach startet das Passende neu – falls etwas geteilt ist.
 */
function restartSharing(): Promise<void> {
  void queueServerStep(async () => {
    if (serverHandle || tunnel.runningMode()) await stopSharing()
  }, 'Teilen neu aufsetzen')
  return reconcileSharing()
}

/** Kurz warten, bis ein gerade startender Tunnel verbunden (oder gescheitert) ist. */
async function waitForTunnel(timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  while (tunnel.runningMode() && tunnel.getState().status === 'starting' && Date.now() < end) {
    await delay(250)
  }
}

/** Ein Upload ist durch (fertig oder abgebrochen): geparktes Fenster freigeben, abgleichen. */
function uploadSettled(): void {
  // Erst nach der laufenden IPC-Antwort freigeben – der Renderer soll sie noch bekommen.
  setTimeout(releaseParkedWindow, 0)
  void reconcileSharing()
}

/** Minütliche Pflege: Abgelaufenes löschen, verwaiste Uploads verwerfen, Teilen abgleichen. */
async function sweepTick(): Promise<void> {
  try {
    const removed = await store.sweepExpired()
    if (removed.length) broadcast('shares:expired', removed)
    if ((await store.abortStaleUploads(STALE_UPLOAD_MS)).length) releaseParkedWindow()
  } catch (e) {
    logError('Aufräumen', e)
  }
  await reconcileSharing()
}

/** Token für den eigenen Tunnel: nur druckbare Zeichen ohne Leerraum, begrenzt. */
function cleanToken(raw: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, '')
    .replace(/[^\x21-\x7e]/g, '')
    .slice(0, 4096)
}

function registerIpc(): void {
  // ---- Updates ----
  ipcMain.handle('update:status', () => getUpdateStatus())
  ipcMain.handle('update:check', () => {
    checkForUpdatesNow()
    return getUpdateStatus()
  })
  ipcMain.handle('update:install', () => {
    isQuitting = true // sonst hält der Fenster-Schließen-Handler das Beenden auf
    if (quitAndInstallUpdate()) return { ok: true as const }
    // Nichts heruntergeladen oder der Installer ließ sich nicht starten: Flag wieder
    // zurück (sonst beendet sich die App beim nächsten Schließen ungewollt) und dem
    // Fenster Bescheid geben, statt es stumm hängen zu lassen.
    isQuitting = false
    const status: UpdateStatus = {
      state: 'error',
      message: 'Das Update ließ sich nicht starten. Versuch es später noch mal.'
    }
    broadcast('update:status', status)
    return { ok: false as const, status }
  })
  ipcMain.handle('updates:get', () => ({
    auto: config.get().updates.auto,
    mode: getUpdateMode(),
    releasesUrl: RELEASES_URL
  }))
  ipcMain.handle('updates:set', async (_e, patch: { auto?: boolean }) => {
    if (typeof patch?.auto === 'boolean') {
      await config.patch({ updates: { ...config.get().updates, auto: patch.auto } })
      setAutoCheck(patch.auto)
    }
    return { auto: config.get().updates.auto, mode: getUpdateMode(), releasesUrl: RELEASES_URL }
  })

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    license: 'MIT',
    repoUrl: REPO_URL,
    releasesUrl: RELEASES_URL,
    relayBase: RELAY_BASE,
    relayInfoUrl: RELAY_BASE + RELAY_INFO_PATH,
    relayPrivacyUrl: RELAY_BASE + RELAY_PRIVACY_PATH,
    relayImprintUrl: RELAY_BASE + RELAY_IMPRINT_PATH
  }))

  // ---- Oberflächen-Einstellungen (robust in der Config gespiegelt) ----
  // Synchron, damit der Renderer das Theme VOR dem ersten Zeichnen kennt (kein Blitz).
  ipcMain.on('ui:get', (e) => {
    e.returnValue = config.get().ui
  })
  ipcMain.on('ui:set', (_e, patch: Partial<AppConfig['ui']>) => {
    const clean: Partial<AppConfig['ui']> = {}
    if (patch?.theme === 'light' || patch?.theme === 'dark') clean.theme = patch.theme
    for (const k of ['previews', 'bannerDismissed'] as const) {
      if (typeof patch?.[k] === 'boolean') clean[k] = patch[k]
    }
    void config
      .patch({ ui: { ...config.get().ui, ...clean } })
      .catch((err) => logError('Oberflächen-Einstellung speichern', err))
  })
  // Der Renderer hat zum ersten Mal gezeichnet (nur für die Start-Messung).
  ipcMain.on('window:app-ready', () => trace('react-rendered'))

  // ---- Upload / Freigabe erstellen (gestreamt) ----
  ipcMain.handle('share:begin', (_e, a: { name: string; mime: string }) => {
    const id = store.begin(a.name, a.mime)
    // Schon jetzt hochfahren: Der Tunnel verbindet, während die Datei noch läuft.
    void reconcileSharing()
    return id
  })

  ipcMain.handle('share:chunk', async (_e, a: { id: string; chunk: ArrayBuffer }) => {
    const ok = await store.write(a.id, Buffer.from(a.chunk))
    return { ok }
  })

  ipcMain.handle('share:end', async (_e, a: { id: string }) => {
    // Gleich geht ein Link raus: Server sicher an (der offene Upload ist ein Grund).
    await reconcileSharing()
    try {
      const meta = await store.finalize(a.id, defaultExpiresAt())
      if (!meta) return { ok: false as const }

      // Vor Herausgabe des Links auf Schadsoftware prüfen (Defender bzw. ClamAV).
      if (config.get().scanUploads) {
        const verdict = await scanFile(store.binPath(meta.id))
        if (verdict === 'infected') {
          await store.remove(meta.id)
          return {
            ok: false as const,
            error: 'Der Virenscan hat in der Datei Schadsoftware gefunden. Sie wird nicht geteilt.'
          }
        }
      }

      return { ok: true as const, share: toShare(meta) }
    } finally {
      uploadSettled()
    }
  })

  ipcMain.handle('share:abort', async (_e, a: { id: string }) => {
    await store.abort(a.id)
    uploadSettled()
    return { ok: true as const }
  })

  // ---- Sammel-Upload: mehrere Dateien, EINE Freigabe ----
  // Die Chunks laufen über share:chunk (die uploadId ist dort die Kennung).
  ipcMain.handle('bundle:begin', (_e, a: { files: { name: string; mime: string }[] }) => {
    const files = Array.isArray(a?.files) ? a.files : []
    if (files.length === 0) throw new Error('Keine Dateien')
    // Aufrufer ist zwar der eigene Renderer, aber ein versehentlich reingezogener
    // Ordner mit tausenden Dateien soll nicht die ganze Ablage fluten.
    if (files.length > MAX_BUNDLE_FILES) {
      throw new Error(`Höchstens ${MAX_BUNDLE_FILES} Dateien passen in eine Freigabe.`)
    }
    const opened = store.beginBundle(
      files.map((f) => ({ name: String(f?.name ?? ''), mime: String(f?.mime ?? '') }))
    )
    // Schon jetzt hochfahren: Der Tunnel verbindet, während die Dateien noch laufen.
    void reconcileSharing()
    return opened
  })

  ipcMain.handle('bundle:end', async (_e, a: { id: string }) => {
    // Gleich geht ein Link raus: Server sicher an (der offene Upload ist ein Grund).
    await reconcileSharing()
    try {
      const meta = await store.finalizeBundle(a.id, defaultExpiresAt())
      if (!meta) return { ok: false as const }

      // Vor Herausgabe des Links jede Teildatei prüfen – nacheinander, weil
      // Defender/ClamAV bei vielen gleichzeitigen Scans einbrechen. Ein Fund
      // kippt die ganze Sammlung.
      if (config.get().scanUploads) {
        for (const f of meta.files ?? []) {
          const verdict = await scanFile(store.binPath(meta.id, f.fid))
          if (verdict === 'infected') {
            await store.remove(meta.id)
            return {
              ok: false as const,
              error: `Der Virenscan hat in „${f.name}“ Schadsoftware gefunden. Deshalb wird die ganze Sammlung nicht geteilt.`
            }
          }
        }
      }

      return { ok: true as const, share: toShare(meta) }
    } finally {
      uploadSettled()
    }
  })

  ipcMain.handle('bundle:abort', async (_e, a: { id: string }) => {
    await store.abortBundle(a.id)
    uploadSettled()
    return { ok: true as const }
  })

  // ---- Verwaltung ----
  ipcMain.handle('shares:list', async () =>
    (await store.list()).filter((m) => !m.expiresAt || m.expiresAt > Date.now()).map(toShare)
  )

  ipcMain.handle('shares:delete', async (_e, id: string) => {
    await store.remove(id)
    void reconcileSharing() // evtl. war das die letzte Freigabe
    return { ok: true as const }
  })

  ipcMain.handle('shares:setExpiry', async (_e, a: { id: string; expiresAt: number | null }) => {
    const meta = await store.setExpiry(a.id, a.expiresAt)
    void reconcileSharing() // neuer Ablauf -> neuer Zeitpunkt zum Nachsehen
    if (!meta) return { ok: false as const }
    return { ok: true as const, share: toShare(meta) }
  })

  // ---- Allgemeine Einstellungen (Standard-Ablauf, Infobereich, Autostart, Virenscan) ----
  const settingsSnapshot = (): {
    defaultTtlHours: number
    closeToTray: boolean
    autostart: boolean
    scanUploads: boolean
    scannerFound: boolean
  } => ({
    defaultTtlHours: config.get().defaultTtlHours,
    closeToTray: config.get().closeToTray,
    autostart: config.get().autostart,
    scanUploads: config.get().scanUploads,
    // Ohne Scanner (Linux ohne ClamAV) lässt der Virenscan alles durch – die
    // Oberfläche kann das so ehrlich anzeigen.
    scannerFound: findScanCommand() !== null
  })

  // ---- Screenshot-Aufnahme ----
  const captureSnapshot = (): CaptureConfig & {
    hotkeyActive: boolean
    unavailable: 'wayland' | null
  } => ({
    ...config.get().capture,
    hotkeyActive: isHotkeyActive(),
    // Linux/Wayland: Aufnahme geht dort nicht (siehe capture.ts), unter Windows immer null.
    unavailable: captureUnavailableReason()
  })
  ipcMain.handle('capture:get', () => captureSnapshot())
  ipcMain.handle('capture:set', async (_e, patch: Partial<CaptureConfig>) => {
    await config.patch({ capture: { ...config.get().capture, ...patch } })
    updateHotkey()
    refreshTrayTooltip() // der Tooltip nennt den Hotkey
    return captureSnapshot()
  })
  ipcMain.handle('capture:pickSaveDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return { ok: false as const }
    await config.patch({ capture: { ...config.get().capture, saveDir: r.filePaths[0] } })
    return { ok: true as const, path: r.filePaths[0] }
  })
  ipcMain.handle('capture:pickEditor', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      // Linux-Programme haben keine Endung -> dort alle Dateien anbieten.
      filters: isWindows
        ? [{ name: 'Programme', extensions: ['exe'] }]
        : [{ name: 'Alle Dateien', extensions: ['*'] }]
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false as const }
    await config.patch({ capture: { ...config.get().capture, editorPath: r.filePaths[0] } })
    return { ok: true as const, path: r.filePaths[0] }
  })

  ipcMain.handle('settings:get', () => settingsSnapshot())

  ipcMain.handle(
    'settings:set',
    async (
      _e,
      patch: {
        defaultTtlHours?: number
        closeToTray?: boolean
        autostart?: boolean
        scanUploads?: boolean
      }
    ) => {
      const clean: Partial<AppConfig> = {}
      if (typeof patch?.defaultTtlHours === 'number' && patch.defaultTtlHours >= 0) {
        clean.defaultTtlHours = patch.defaultTtlHours
      }
      for (const k of ['closeToTray', 'autostart', 'scanUploads'] as const) {
        if (typeof patch?.[k] === 'boolean') clean[k] = patch[k]
      }
      await config.patch(clean)
      updateTray()
      if (clean.autostart !== undefined) applyAutostart()
      return settingsSnapshot()
    }
  )

  ipcMain.handle('server:info', () => serverInfo())

  // ---- Links: Betriebsart, eigene Domain, Zustand ----
  ipcMain.handle('links:get', () => linksSnapshot())

  // Hinweis vor der ersten Relay-Anmeldung bestätigt („Okay, Link erstellen“).
  ipcMain.handle('links:acceptRelay', async () => {
    if (!config.get().relay.noticeAccepted) {
      await config.patch({ relay: { ...config.get().relay, noticeAccepted: true } })
      await reconcileSharing()
      broadcastLinkStatus()
    }
    return linksSnapshot()
  })

  ipcMain.handle(
    'links:set',
    async (_e, patch: { mode?: LinkMode; publicBaseUrl?: string; token?: string }) => {
      const cfg = config.get()
      const next: Partial<AppConfig> = {}
      if (patch?.mode === 'relay' || patch?.mode === 'lan' || patch?.mode === 'domain') {
        next.linkMode = patch.mode
      }
      if (typeof patch?.publicBaseUrl === 'string') {
        const url = normalizeBaseUrl(patch.publicBaseUrl)
        if (url === null) {
          return { ok: false as const, error: 'Das sieht nicht nach einer Web-Adresse aus.', ...linksSnapshot() }
        }
        next.publicBaseUrl = url
      }
      if (typeof patch?.token === 'string') next.tunnel = { ...cfg.tunnel, token: cleanToken(patch.token) }
      const changed =
        (next.linkMode !== undefined && next.linkMode !== cfg.linkMode) ||
        (next.publicBaseUrl !== undefined && next.publicBaseUrl !== cfg.publicBaseUrl) ||
        (next.tunnel !== undefined && next.tunnel.token !== cfg.tunnel.token)
      if (!changed) return { ok: true as const, ...linksSnapshot() }
      await config.patch(next)
      await restartSharing()
      broadcastServerInfo()
      await broadcastShareUrls()
      return { ok: true as const, ...linksSnapshot() }
    }
  )

  // Ehrliche Erreichbarkeitsprüfung der eigenen Domain: Erreicht sie wirklich diesen
  // Server? Läuft im Main-Prozess, damit keine CSP-Grenze im Renderer stört.
  ipcMain.handle('links:testDomain', async () => {
    // Testen braucht Server und Tunnel – auch im Ruhezustand. Eine Weile
    // festhalten und einem gerade startenden Tunnel Zeit zum Verbinden geben.
    holdSharing(HOLD_MS)
    await reconcileSharing()
    await waitForTunnel(15_000)
    const base = lanOrDomainBase()
    const target = `${base}/api/health`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 7000)
    try {
      const res = await fetch(target, { signal: controller.signal })
      const json = (await res.json().catch(() => null)) as { app?: string } | null
      const ok = res.ok && json?.app === 'Foldwing'
      return { ok, status: res.status, target, isThisServer: json?.app === 'Foldwing' }
    } catch (e) {
      const err = e as { name?: string; message?: string }
      return {
        ok: false,
        target,
        error: err?.name === 'AbortError' ? 'timeout' : (err?.message ?? 'unbekannt')
      }
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    safeOpenExternal(url)
    return { ok: true as const }
  })

  // Eigene Titelleiste: Farben der nativen Fenster-Schaltflächen dem Theme anpassen.
  ipcMain.on('window:titleBarOverlay', (e, colors: { color: string; symbolColor: string }) => {
    try {
      BrowserWindow.fromWebContents(e.sender)?.setTitleBarOverlay({ ...colors, height: 44 })
    } catch {
      /* Plattform/Version ohne Overlay-Unterstützung -> ignorieren */
    }
  })
}

/** Metadaten um die fertige, teilbare URL ergänzen. */
function toShare(meta: ShareMeta): ShareMeta & { url: string } {
  return { ...meta, url: shareUrl(meta.id) }
}

/** Einen Screenshot über den bestehenden Ablage-/Freigabe-Pfad hochladen. */
async function uploadScreenshot(
  buffer: Buffer,
  filename: string
): Promise<(ShareMeta & { url: string }) | null> {
  const id = store.begin(filename, 'image/png')
  try {
    // Der Link muss sofort funktionieren: Im Ruhezustand jetzt Server (und Tunnel)
    // hochfahren – der offene Upload ist ein Grund, danach die neue Freigabe.
    await reconcileSharing()
    await store.write(id, buffer)
    const meta = await store.finalize(id, defaultExpiresAt())
    if (!meta) return null
    return toShare(meta)
  } finally {
    uploadSettled()
  }
}

/** Der laufenden App-Oberfläche eine neue Freigabe live bekannt machen. */
function broadcastShareAdded(share: ShareMeta & { url: string }): void {
  broadcast('shares:added', share)
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

/**
 * Eine beliebige Datei vom Pfad teilen (aus dem Rechtsklick-Eintrag „Mit Foldwing
 * teilen"). Wird gestreamt in die Ablage geschrieben (auch große Dateien), wie jeder
 * andere Upload auf Schadsoftware geprüft, der Link landet in der Zwischenablage und
 * die neue Freigabe erscheint live in der App.
 */
async function shareFileFromPath(filePath: string): Promise<void> {
  if (!filePath) return
  let stat: import('fs').Stats
  try {
    stat = await fsp.stat(filePath)
  } catch {
    return // Datei existiert nicht (mehr)
  }
  if (!stat.isFile()) {
    notify('Ordner lassen sich nicht teilen', 'Wähl bitte eine Datei aus.')
    return
  }
  const name = basename(filePath)
  const id = store.begin(name, mimeFromName(name))
  // Schon jetzt hochfahren: Der Tunnel verbindet, während die Datei noch läuft.
  void reconcileSharing()
  try {
    const rs = createReadStream(filePath)
    for await (const chunk of rs) await store.write(id, chunk as Buffer)
  } catch {
    await store.abort(id)
    uploadSettled()
    notify('Teilen hat nicht geklappt', 'Die Datei ließ sich nicht lesen.')
    return
  }
  let meta: ShareMeta | null
  try {
    // Gleich geht ein Link raus: Server sicher an (der offene Upload ist ein Grund).
    await reconcileSharing()
    meta = await store.finalize(id, defaultExpiresAt())
    if (!meta) {
      notify('Teilen hat nicht geklappt', 'Die Datei ließ sich nicht in die Ablage schreiben.')
      return
    }
    // Vor Herausgabe des Links auf Schadsoftware prüfen (wie bei allen Uploads).
    if (config.get().scanUploads) {
      const verdict = await scanFile(store.binPath(meta.id))
      if (verdict === 'infected') {
        await store.remove(meta.id)
        notify('Nicht geteilt', 'Der Virenscan hat in der Datei Schadsoftware gefunden.')
        return
      }
    }
  } finally {
    uploadSettled()
  }
  const share = toShare(meta)
  await clipboard.writeText(share.url).catch(() => undefined)
  broadcastShareAdded(share)
  showMainWindow()
  notify('Link kopiert', `${meta.name} ist geteilt. Der Link liegt in der Zwischenablage.`)
}

/**
 * Einträge der alten FlowShare-Installation (Rechtsklick, Autostart) einmalig
 * entfernen. Ein Merker im Datenordner verhindert, dass das bei jedem Start läuft.
 */
async function removeLegacyEntriesOnce(): Promise<void> {
  const marker = join(app.getPath('userData'), 'legacy-cleaned')
  if (existsSync(marker)) return
  try {
    if (isWindows) await removeLegacyWindowsEntries(regExePath())
    else if (isLinux) await removeLegacyLinuxFiles(xdgDataHome(), xdgConfigHome())
    await fsp.writeFile(marker, '')
  } catch {
    /* beim nächsten Start erneut */
  }
}

/**
 * „Mit Foldwing teilen"-Eintrag sicherstellen. Nur die echte Installation trägt
 * sich ein – ein entpackter Test-Build (release/win-unpacked) würde den Eintrag
 * sonst auf sich umbiegen. Ob er stimmt, wird bei jedem Start direkt geprüft
 * (Registry bzw. .desktop-Datei); fehlt er oder zeigt woandershin, neu eintragen.
 */
async function maybeRegisterContextMenu(): Promise<void> {
  if (!isInstalledBuild()) return
  await removeLegacyEntriesOnce()
  const exe = stableExePath()
  if (await isShareContextMenuRegistered(exe)) return
  await registerShareContextMenu(exe)
}
