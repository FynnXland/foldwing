import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Notification,
  screen,
  shell,
  NativeImage,
  Display,
  IpcMainEvent,
  IpcMainInvokeEvent
} from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import type { CaptureConfig } from './config'
import { enumerateWindows, disposeWindowHelper } from './capture-window-list'
import { createIdleRelease } from './capture-idle'
import { isWaylandSession, isWindows } from './platform'
import { defaultPicturesDir } from './legacy'
import { APP_NAME } from './brand'
import { toPhysicalRect, insetRect, type DetectedWindow, type Rect } from './capture-geometry'

// Erkannte Fenster minimal nach innen beschneiden (DIP), damit kein dünner Rand aus
// Schatten/runder Ecke bzw. Desktop mit auf den Screenshot kommt. Nur für die
// automatische Fenster-Auswahl – Ziehen und Vollbild bleiben unangetastet.
const WINDOW_TRIM = 2

interface ShareLike {
  id: string
  name: string
  mime: string
  size: number
  createdAt: number
  expiresAt?: number
  url: string
}

export interface CaptureDeps {
  captureConfig: () => CaptureConfig
  /** Screenshot über den bestehenden Foldwing-Upload speichern und Link liefern. */
  uploadScreenshot: (buffer: Buffer, filename: string) => Promise<ShareLike | null>
  /** Fertige Freigabe der laufenden App-Oberfläche bekannt machen. */
  onShareAdded: (share: ShareLike) => void
}

let deps: CaptureDeps
let actionWin: BrowserWindow | null = null
let actionBusy = false
let busy = false
let registeredHotkey = ''
// Pro Monitor das aufgenommene Vollbild (physische Auflösung) für den späteren Zuschnitt.
const shots = new Map<number, { image: NativeImage; scaleFactor: number }>()
let pending: { buffer: Buffer; width: number; height: number } | null = null

/**
 * Overlay-Fenster: pro Monitor eins, angelegt erst beim Druck auf den Hotkey und
 * direkt nach der Aufnahme wieder zerstört. Es lädt parallel zur Bildschirmaufnahme,
 * die ohnehin länger dauert – gemessen erscheint das Overlay kalt sogar früher als
 * ein vorgeladenes (lange versteckte Fenster zeichnen gedrosselt). Ein Vorhalten
 * bringt also nichts und kostet pro Monitor einen Renderer-Prozess (~60 MB).
 */
const pool = new Map<number, { win: BrowserWindow; ready: Promise<void> }>()
let activeDisplayIds: number[] = []
// Laufende Nummer pro Aufnahme: verhindert, dass eine verspätete Fensterliste
// einer alten Aufnahme in eine neue hineinfunkt.
let captureGen = 0
// Zwischen initCapture und disposeCapture – danach plant nichts mehr eine Freigabe.
let captureActive = false

/**
 * Wie lange der Fenster-Helfer (PowerShell, ~65 MB) nach einer Aufnahme bereit
 * bleibt – ab dem Moment, in dem Overlays UND Aktionsleiste zu sind. Warm liefert
 * er die Fensterrahmen in ~5 ms statt ~0,4 s; eine Minute deckt Serienaufnahmen ab
 * (aufnehmen, hochladen, einfügen, nächste Aufnahme) und gibt danach alles frei.
 */
const CAPTURE_IDLE_MS = 60_000

const idleRelease = createIdleRelease({
  delayMs: CAPTURE_IDLE_MS,
  inUse: () => busy || isActionBarOpen(),
  release: releaseCaptureResources
})

function isActionBarOpen(): boolean {
  return !!actionWin && !actionWin.isDestroyed()
}

/** Fenster-Helfer freigeben (Overlays sind dann längst zu) – die nächste Aufnahme startet ihn neu. */
function releaseCaptureResources(): void {
  destroyOverlayPool() // Sicherheitsnetz, falls doch noch eins übrig ist
  disposeWindowHelper()
}

/** Aufnahme-Sitzung vorbei -> Leerlauf-Zeitgeber (neu) starten; nach disposeCapture nicht mehr. */
function scheduleIdleRelease(): void {
  if (captureActive) idleRelease.arm()
}

function loadRenderer(win: BrowserWindow, hash: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(`${devUrl}#${hash}`)
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash })
}

function timestampName(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `Screenshot ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.png`
}

function createOverlayWindow(display: Display): { win: BrowserWindow; ready: Promise<void> } {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      // Auch im versteckten Zustand rendern lassen: so ist das neue Standbild
      // schon fertig gezeichnet, bevor das Fenster erscheint (kein Aufblitzen).
      backgroundThrottling: false,
      // Kein Texteingabefeld -> Rechtschreibprüfung gar nicht erst laden.
      spellcheck: false
    }
  })
  const ready = new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => resolve())
  })
  loadRenderer(win, 'capture')
  return { win, ready }
}

// Der Renderer meldet pro Aufnahme, sobald das neue Standbild gezeichnet ist –
// erst dann wird das Overlay eingeblendet (übergangslos, ohne Schwarz-Blitzer).
const overlayReady = new Map<number, () => void>()
function waitForOverlayPainted(displayId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(finish, timeoutMs)
    function finish(): void {
      if (done) return
      done = true
      clearTimeout(timer)
      overlayReady.delete(displayId)
      resolve()
    }
    overlayReady.set(displayId, finish)
  })
}

/**
 * Pool an die aktuelle Monitor-Konfiguration angleichen (fehlende anlegen, alte weg).
 * Nur aus beginCapture – im Leerlauf entstehen keine Fenster.
 */
function ensureOverlayPool(): void {
  if (!deps.captureConfig().enabled) return
  const displays = screen.getAllDisplays()
  const liveIds = new Set(displays.map((d) => d.id))
  for (const [id, entry] of pool) {
    if (!liveIds.has(id) || entry.win.isDestroyed()) {
      if (!entry.win.isDestroyed()) entry.win.destroy()
      pool.delete(id)
    }
  }
  for (const d of displays) {
    if (!pool.has(d.id)) pool.set(d.id, createOverlayWindow(d))
  }
}

function destroyOverlayPool(): void {
  for (const [, entry] of pool) if (!entry.win.isDestroyed()) entry.win.destroy()
  pool.clear()
}

/** OS-Fensterhandle (HWND) eines BrowserWindow als Zahl – passt zu PowerShells ToInt64(). */
function nativeHandle(win: BrowserWindow): number | null {
  try {
    const buf = win.getNativeWindowHandle()
    if (buf.length >= 8) return Number(buf.readBigInt64LE(0))
    if (buf.length >= 4) return buf.readInt32LE(0)
    return null
  } catch {
    return null
  }
}

/** Handles der eigenen Aufnahme-Fenster (Overlays + Aktionsleiste) – von der Erkennung ausnehmen. */
function ownCaptureHandles(): Set<number> {
  const set = new Set<number>()
  for (const [, entry] of pool) {
    if (entry.win.isDestroyed()) continue
    const h = nativeHandle(entry.win)
    if (h != null) set.add(h)
  }
  if (actionWin && !actionWin.isDestroyed()) {
    const h = nativeHandle(actionWin)
    if (h != null) set.add(h)
  }
  return set
}

/**
 * Overlays schließen und Aufnahmezustand zurücksetzen. Die Fenster werden sofort
 * zerstört (nicht nur versteckt) – die nächste Aufnahme legt sie frisch an, ohne
 * Zeitverlust (siehe Kommentar am Pool). Danach startet der Leerlauf-Zeitgeber für
 * den Fenster-Helfer; eine gleich geöffnete Aktionsleiste hält ihn an, bis sie zu ist.
 */
function closeOverlays(): void {
  destroyOverlayPool()
  activeDisplayIds = []
  shots.clear()
  busy = false
  scheduleIdleRelease()
}

async function beginCapture(): Promise<void> {
  if (busy || !deps.captureConfig().enabled) return
  busy = true
  idleRelease.cancel() // Aufnahme läuft -> nichts abräumen
  const gen = ++captureGen
  try {
    // Overlays sicherstellen, bevor wir ihre Handles von der Erkennung ausnehmen.
    // Nach dem Leerlauf entstehen sie hier frisch. Reihenfolge ist wichtig:
    // getSources unten blockiert den Hauptprozess für die Dauer der Aufnahme –
    // vorher angelegte Fenster (und der Fenster-Helfer) laden in der Zeit parallel,
    // danach angelegte würden erst hinterher starten.
    ensureOverlayPool()
    // Fensterliste PARALLEL anstoßen – sie blockiert das Overlay nicht mehr,
    // die erkannten Boxen werden nachgereicht, sobald sie da sind. Die eigenen
    // Aufnahme-Fenster werden ausgeschlossen, das Hauptfenster bleibt wählbar.
    const winsPromise = enumerateWindows(2000, ownCaptureHandles())

    const displays = screen.getAllDisplays()
    const maxW = Math.max(...displays.map((d) => d.size.width * d.scaleFactor))
    const maxH = Math.max(...displays.map((d) => d.size.height * d.scaleFactor))
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.ceil(maxW), height: Math.ceil(maxH) }
    })

    ensureOverlayPool()
    const shown: { display: Display; entry: { win: BrowserWindow; ready: Promise<void> } }[] = []

    for (const [i, display] of displays.entries()) {
      const source =
        sources.find((s) => s.display_id === String(display.id)) ?? sources[i] ?? sources[0]
      if (!source) continue
      let entry = pool.get(display.id)
      if (!entry || entry.win.isDestroyed()) {
        entry = createOverlayWindow(display)
        pool.set(display.id, entry)
      }
      const physW = Math.round(display.size.width * display.scaleFactor)
      const physH = Math.round(display.size.height * display.scaleFactor)
      const image = source.thumbnail.resize({ width: physW, height: physH })
      shots.set(display.id, { image, scaleFactor: display.scaleFactor })

      await entry.ready
      if (entry.win.isDestroyed()) continue
      const win = entry.win
      win.setBounds(display.bounds)
      // JPEG statt PNG: Bruchteil der Datenmenge über IPC, fürs Overlay nicht
      // unterscheidbar – der spätere Zuschnitt nutzt das verlustfreie Original.
      const overlayJpeg = `data:image/jpeg;base64,${image.toJPEG(90).toString('base64')}`
      const painted = waitForOverlayPainted(display.id, 250)
      win.webContents.send('capture:init', {
        displayId: display.id,
        scaleFactor: display.scaleFactor,
        bounds: { width: display.bounds.width, height: display.bounds.height },
        image: overlayJpeg,
        windows: [],
        magnifier: deps.captureConfig().magnifier
      })
      const isFirst = shown.length === 0
      // Erst zeigen, wenn das Standbild wirklich gezeichnet ist -> kein Blitzer,
      // und das sanfte Einblenden der Abdunklung startet sichtbar von Anfang an.
      void painted.then(() => {
        if (gen !== captureGen || win.isDestroyed()) return
        win.setAlwaysOnTop(true, 'screen-saver')
        win.show()
        if (isFirst) win.focus()
      })
      activeDisplayIds.push(display.id)
      shown.push({ display, entry })
    }

    if (shown.length === 0) {
      closeOverlays()
      return
    }

    // Erkannte Fenster nachreichen (globale physische Koordinaten -> monitor-lokale DIP).
    const raw = await winsPromise
    if (!busy || gen !== captureGen || raw.length === 0) return
    const globalWins = raw.map((w) => {
      const dip = screen.screenToDipRect(null as unknown as BrowserWindow, {
        x: w.left,
        y: w.top,
        width: w.right - w.left,
        height: w.bottom - w.top
      })
      return { ...dip, title: w.title }
    })
    for (const { display, entry } of shown) {
      if (entry.win.isDestroyed()) continue
      const localWindows: DetectedWindow[] = globalWins
        .filter((w) => {
          const cx = w.x + w.width / 2
          const cy = w.y + w.height / 2
          return (
            cx >= display.bounds.x &&
            cx <= display.bounds.x + display.bounds.width &&
            cy >= display.bounds.y &&
            cy <= display.bounds.y + display.bounds.height
          )
        })
        .map((w) => {
          const local = insetRect(
            { x: w.x - display.bounds.x, y: w.y - display.bounds.y, width: w.width, height: w.height },
            WINDOW_TRIM
          )
          return { ...local, title: w.title }
        })
      entry.win.webContents.send('capture:windows', { windows: localWindows })
    }
  } catch {
    closeOverlays()
  }
}

/** Auswahl bestätigt: passenden Screenshot zuschneiden und Aktionsfenster öffnen. */
function onConfirm(displayId: number, rect: Rect): void {
  const shot = shots.get(displayId)
  closeOverlays()
  if (!shot) return
  const size = shot.image.getSize()
  const phys = toPhysicalRect(rect, shot.scaleFactor)
  const x = Math.max(0, Math.min(phys.x, size.width))
  const y = Math.max(0, Math.min(phys.y, size.height))
  const width = Math.max(1, Math.min(phys.width, size.width - x))
  const height = Math.max(1, Math.min(phys.height, size.height - y))
  const cropped = shot.image.crop({ x, y, width, height })
  const buffer = cropped.toPNG()
  pending = { buffer, width, height }
  const thumb = `data:image/jpeg;base64,${cropped.toJPEG(85).toString('base64')}`
  openActionWindow(thumb, width, height)
}

// Sichtbare Leiste + transparenter Rand ringsum, damit der Schatten Platz hat.
const BAR_W = 404
const BAR_H = 140
const BAR_PAD = 34

/**
 * Position der Aktionsleiste: immer vollständig auf dem Monitor, auf dem der
 * Cursor steht. Mittig unter dem Cursor; klappt nach oben, wenn unten kein Platz
 * ist, und wird an den Rändern hineingeschoben (rechts außen -> öffnet nach links).
 */
function actionWindowBounds(): { x: number; y: number; width: number; height: number } {
  const winW = BAR_W + BAR_PAD * 2
  const winH = BAR_H + BAR_PAD * 2
  const cursor = screen.getCursorScreenPoint()
  const wa = screen.getDisplayNearestPoint(cursor).workArea
  // Zielrechteck der SICHTBAREN Leiste (ohne den transparenten Schatten-Rand).
  let barX = Math.round(cursor.x - BAR_W / 2)
  let barY = Math.round(cursor.y + 18)
  if (barY + BAR_H > wa.y + wa.height - 8) barY = Math.round(cursor.y - 18 - BAR_H)
  barX = Math.max(wa.x + 8, Math.min(barX, wa.x + wa.width - BAR_W - 8))
  barY = Math.max(wa.y + 8, Math.min(barY, wa.y + wa.height - BAR_H - 8))
  return { x: barX - BAR_PAD, y: barY - BAR_PAD, width: winW, height: winH }
}

function openActionWindow(dataUrl: string, width: number, height: number): void {
  const win = new BrowserWindow({
    ...actionWindowBounds(),
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    transparent: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      spellcheck: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  loadRenderer(win, 'capture-actions')
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('capture:actions:init', { image: dataUrl, width, height })
    win.show()
    win.focus()
  })
  win.on('blur', () => {
    // Während einer laufenden Aktion (z. B. Upload) nicht wegklicken lassen –
    // stattdessen merken, damit capture:action nach Abschluss sauber nachschließt
    // (sonst bleibt die Leiste hängen, wenn der Fokus nur während des Uploads weg war).
    if (actionBusy) {
      blurredWhileBusy = true
      return
    }
    if (!win.isDestroyed()) win.close()
  })
  win.on('closed', () => {
    if (actionWin === win) actionWin = null
    pending = null
    // Erst jetzt ist die Aufnahme samt Hochladen wirklich durch -> Leerlauf-Zeitgeber.
    scheduleIdleRelease()
  })
  actionWin = win
  // Solange die Leiste offen ist (z. B. während des Hochladens), nichts abräumen.
  idleRelease.cancel()
}

/** Zielordner zum Speichern (konfiguriert oder Standard Bilder/Foldwing). */
function saveDir(): string {
  return deps.captureConfig().saveDir || defaultPicturesDir(app.getPath('pictures'), APP_NAME)
}

async function doSave(): Promise<void> {
  if (!pending) return
  const dir = saveDir()
  await fsp.mkdir(dir, { recursive: true })
  const path = join(dir, timestampName())
  await fsp.writeFile(path, pending.buffer)
  notify('Screenshot gespeichert', path)
  shell.showItemInFolder(path)
}

/**
 * „Immer speichern": legt den Screenshot still im Speicherordner ab – für die
 * Aktionen Hochladen/Kopieren/Bearbeiten, damit nichts verloren geht, auch wenn
 * man Speichern nicht anklickt. Fehler bleiben stumm (Aktion soll nicht scheitern).
 */
async function persistIfAlways(): Promise<void> {
  if (!pending || !deps.captureConfig().alwaysSave) return
  try {
    const dir = saveDir()
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, timestampName()), pending.buffer)
  } catch {
    /* Ablage fehlgeschlagen (z. B. Ordner nicht schreibbar) -> Aktion läuft weiter */
  }
}

// „Öffnen mit"-Auswahl: Windows hat dafür OpenWith.exe (nimmt den Pfad sauber
// als Argument, auch mit Leerzeichen). Linux kennt keinen systemweiten
// „Öffnen mit"-Dialog per Kommandozeile – dort öffnet die Standard-Anwendung
// (in den Einstellungen lässt sich ein festes Programm wählen).
function openWithDialog(path: string): void {
  if (!isWindows) {
    void shell.openPath(path)
    return
  }
  const openWithExe = join(
    process.env['SystemRoot'] || 'C:\\Windows',
    'System32',
    'OpenWith.exe'
  )
  try {
    spawn(openWithExe, [path], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    shell.openPath(path) // Notfalls mit der Standard-App öffnen
  }
}

/**
 * Temp-Pfad für die Bearbeitung in einem eigenen Unterordner. Räumt dabei alte
 * Kopien (> 1 Stunde) auf, damit sich im Temp-Ordner nichts ansammelt – die
 * frisch geschriebene Datei bleibt (das Bearbeitungsprogramm braucht sie noch).
 */
async function editTempPath(): Promise<string> {
  const dir = join(tmpdir(), 'Foldwing')
  await fsp.mkdir(dir, { recursive: true })
  try {
    const cutoff = Date.now() - 60 * 60_000
    for (const f of await fsp.readdir(dir)) {
      const fp = join(dir, f)
      const st = await fsp.stat(fp).catch(() => null)
      if (st?.isFile() && st.mtimeMs < cutoff) await fsp.rm(fp).catch(() => {})
    }
  } catch {
    /* Aufräumen ist optional */
  }
  return join(dir, timestampName())
}

async function doEdit(): Promise<void> {
  if (!pending) return
  const cfg = deps.captureConfig()
  const path = await editTempPath()
  await fsp.writeFile(path, pending.buffer)
  // Kein fest gewähltes Programm -> openWithDialog übernimmt (fragt unter Windows
  // per OpenWith.exe nach, öffnet unter Linux mit der Standard-Anwendung).
  if (!cfg.editorPath) {
    openWithDialog(path)
    return
  }
  try {
    spawn(cfg.editorPath, [path], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    openWithDialog(path)
  }
}

function doCopy(): void {
  if (!pending) return
  // Bestätigung zeigt die Aktionsleiste selbst – keine Extra-Benachrichtigung nötig.
  // Seit Electron 44 asynchron und nur noch über ClipboardItem (kein writeImage mehr).
  const png = new Blob([new Uint8Array(pending.buffer)], { type: 'image/png' })
  void clipboard.write([new ClipboardItem({ 'image/png': png })]).catch(() => undefined)
}

async function doUpload(): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!pending) return { ok: false, error: 'Die Aufnahme ist nicht mehr da. Mach bitte einen neuen Screenshot.' }
  const name = timestampName()
  const share = await deps.uploadScreenshot(pending.buffer, name)
  if (!share) {
    return { ok: false, error: 'Der Screenshot ließ sich nicht teilen. Versuch es noch einmal.' }
  }
  await clipboard.writeText(share.url).catch(() => undefined)
  deps.onShareAdded(share)
  notify('Link kopiert', 'Der Link zum Screenshot liegt in der Zwischenablage.')
  return { ok: true, url: share.url }
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

export function updateHotkey(): void {
  const cfg = deps.captureConfig()
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey)
    registeredHotkey = ''
  }
  // Unter Wayland meldet Electron den Hotkey zwar als belegt, der Tastendruck kommt
  // aber nur an, solange ein XWayland-Fenster den Fokus hat, und das Bildschirmfoto
  // bleibt schwarz. Dann gar nicht erst belegen – der Status sagt ehrlich „aus“.
  if (!cfg.enabled || !cfg.hotkey || captureUnavailableReason()) {
    // Aufnahme aus -> noch bereite Ressourcen sofort freigeben.
    idleRelease.cancel()
    releaseCaptureResources()
    return
  }
  try {
    if (globalShortcut.register(cfg.hotkey, () => void beginCapture())) registeredHotkey = cfg.hotkey
  } catch {
    /* Hotkey nicht registrierbar -> stumm ignorieren, Settings zeigen Status */
  }
  // Bewusst nichts vorwärmen: Overlays und Fenster-Helfer entstehen erst bei der
  // ersten Aufnahme – im Leerlauf läuft nur der Hotkey.
}

export function isHotkeyActive(): boolean {
  return !!registeredHotkey
}

/** Warum die Aufnahme auf diesem System nicht geht (null = sie geht). Nur Linux/Wayland. */
export function captureUnavailableReason(): 'wayland' | null {
  return isWaylandSession() ? 'wayland' : null
}

// Als benannte Funktionen auf Modulebene angelegt (statt Closures in initCapture),
// damit disposeCapture dieselben Referenzen zum Abmelden verwenden kann –
// initCapture bleibt so nach disposeCapture ohne Doppel-Registrierung erneut aufrufbar.

/**
 * Monitor-Wechsel: vorhandene Overlays passen nicht mehr -> nur verwerfen. Neu
 * angelegt wird erst bei der nächsten Aufnahme, im Leerlauf entstehen keine Fenster.
 */
function onDisplaysChanged(): void {
  if (busy) closeOverlays()
  destroyOverlayPool()
}

function handleCaptureConfirm(_e: IpcMainEvent, a: { displayId: number; rect: Rect }): void {
  onConfirm(a.displayId, a.rect)
}

function handleCaptureReady(_e: IpcMainEvent, displayId: number): void {
  overlayReady.get(displayId)?.()
}

function handleCaptureCancel(): void {
  closeOverlays()
}

// Merkt sich, ob die Aktionsleiste während einer laufenden Aktion den Fokus verlor
// (blur kam da absichtlich ohne Wirkung) -> capture:action holt das Schließen nach.
let blurredWhileBusy = false

async function handleCaptureAction(
  _e: IpcMainInvokeEvent,
  type: 'save' | 'edit' | 'copy' | 'upload'
): Promise<{ ok: boolean; url?: string; error?: string }> {
  actionBusy = true
  blurredWhileBusy = false
  let result: { ok: boolean; url?: string; error?: string } = { ok: true }
  try {
    if (type === 'save') {
      await doSave() // legt bewusst selbst ab -> kein zweites „Immer speichern"
      return result
    }
    if (type === 'edit') await doEdit()
    else if (type === 'copy') doCopy()
    else if (type === 'upload') result = await doUpload()
    await persistIfAlways()
    return result
  } finally {
    actionBusy = false
    // Blur kam während der Aktion rein -> Leiste jetzt schließen, außer nach
    // erfolgreichem Upload (bleibt offen für „Im Browser öffnen"/nochmal kopieren).
    const keepOpen = type === 'upload' && result.ok
    if (blurredWhileBusy && !keepOpen && actionWin && !actionWin.isDestroyed()) {
      actionWin.close()
    }
    blurredWhileBusy = false
  }
}

function handleCaptureActionsClose(): void {
  if (actionWin && !actionWin.isDestroyed()) actionWin.close()
}

export function initCapture(d: CaptureDeps): void {
  deps = d
  captureActive = true
  updateHotkey()

  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)
  screen.on('display-metrics-changed', onDisplaysChanged)

  ipcMain.on('capture:confirm', handleCaptureConfirm)
  ipcMain.on('capture:ready', handleCaptureReady)
  ipcMain.on('capture:cancel', handleCaptureCancel)
  // Die Leiste schließt sich selbst (nach Erfolgs-Anzeige) über capture:actions:close.
  ipcMain.handle('capture:action', handleCaptureAction)
  ipcMain.on('capture:actions:close', handleCaptureActionsClose)
}

export function disposeCapture(): void {
  // Zuerst: ab hier plant nichts mehr eine Leerlauf-Freigabe (auch nicht das
  // später feuernde 'closed' der Aktionsleiste), ein laufender Zeitgeber fällt weg.
  captureActive = false
  idleRelease.cancel()
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
  registeredHotkey = ''
  closeOverlays()
  destroyOverlayPool()
  // Aktionsleiste (falls gerade offen) mit schließen – sonst hält sie beim
  // Beenden noch ein BrowserWindow offen.
  if (actionWin && !actionWin.isDestroyed()) actionWin.close()
  disposeWindowHelper()

  screen.removeListener('display-added', onDisplaysChanged)
  screen.removeListener('display-removed', onDisplaysChanged)
  screen.removeListener('display-metrics-changed', onDisplaysChanged)

  ipcMain.removeListener('capture:confirm', handleCaptureConfirm)
  ipcMain.removeListener('capture:ready', handleCaptureReady)
  ipcMain.removeListener('capture:cancel', handleCaptureCancel)
  ipcMain.removeHandler('capture:action')
  ipcMain.removeListener('capture:actions:close', handleCaptureActionsClose)
}
