import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'

export type LinkMode = 'relay' | 'lan' | 'domain'

export type LinkState =
  | 'resting'
  | 'waiting'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'blocked'
  | 'error'

/** Erreichbarkeit der Links – ein Zustand für alle drei Betriebsarten. */
export interface LinkStatus {
  mode: LinkMode
  state: LinkState
  text: string
}

export interface LinksInfo {
  mode: LinkMode
  /** Nur Modus 'domain'. */
  publicBaseUrl: string
  /** Tunnel-Token gespeichert? (Der Token selbst bleibt im Main-Prozess.) */
  hasToken: boolean
  relayBase: string
  relayInfoUrl: string
  relayRulesUrl: string
  relayPrivacyUrl: string
  /** Hinweis vor der ersten Relay-Anmeldung bestätigt? */
  relayAccepted: boolean
  /** Geräte-ID beim Relay (für eine Rückfrage bei einer Sperre); null = noch keine. */
  deviceId: string | null
  effectiveBaseUrl: string
  status: LinkStatus
}

export interface AppInfo {
  version: string
  license: string
  repoUrl: string
  releasesUrl: string
  relayBase: string
  relayInfoUrl: string
  relayPrivacyUrl: string
  relayImprintUrl: string
}

export interface UpdatesInfo {
  auto: boolean
  /** auto = lädt und installiert selbst, manual = nur Hinweis, none = prüft nie. */
  mode: 'auto' | 'manual' | 'none'
  releasesUrl: string
}

export interface UiPrefs {
  theme: 'light' | 'dark'
  previews: boolean
  bannerDismissed: boolean
}

/** Eine einzelne Datei innerhalb einer Sammel-Freigabe. */
export interface ShareFile {
  fid: string
  name: string
  mime: string
  size: number
}

export interface Share {
  id: string
  name: string
  mime: string
  size: number
  createdAt: number
  expiresAt?: number
  url: string
  /** Nur bei Sammlungen gesetzt; fehlt bei klassischen Einzeldateien. */
  files?: ShareFile[]
}

export interface ServerInfo {
  /** false = ruht: nichts geteilt, Server und Tunnel sind aus und starten von selbst. */
  running: boolean
  port: number
  linkMode: LinkMode
  effectiveBaseUrl: string
  lan: string | null
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'manual'; version: string }
  | { state: 'none' }
  | { state: 'error'; message: string }
  | { state: 'disabled' }

/**
 * Sichere Brücke Renderer <-> Main. Der Renderer kennt keinen fs-/http-Zugriff;
 * Uploads werden gestreamt (begin/chunk/end) an den Main-Prozess übergeben, der
 * die Datei speichert und den eingebetteten Server versorgt.
 */
const api = {
  // Plattform der App – für plattformgerechte Beschriftungen in der Oberfläche
  // (z. B. „Mit Windows starten" vs. „Beim Anmelden starten").
  platform: process.platform as string,

  shareBegin: (name: string, mime: string) =>
    ipcRenderer.invoke('share:begin', { name, mime }) as Promise<string>,
  shareChunk: (id: string, chunk: ArrayBuffer) =>
    ipcRenderer.invoke('share:chunk', { id, chunk }) as Promise<{ ok: boolean }>,
  shareEnd: (id: string) =>
    ipcRenderer.invoke('share:end', { id }) as Promise<
      { ok: true; share: Share } | { ok: false; error?: string }
    >,
  shareAbort: (id: string) => ipcRenderer.invoke('share:abort', { id }) as Promise<{ ok: boolean }>,

  // Sammel-Upload: mehrere Dateien, ein Link. Die Chunks laufen weiter über
  // shareChunk – dort ist die uploadId aus bundleBegin die Kennung.
  bundleBegin: (files: { name: string; mime: string }[]) =>
    ipcRenderer.invoke('bundle:begin', { files }) as Promise<{
      id: string
      uploads: { fid: string; uploadId: string }[]
    }>,
  bundleEnd: (id: string) =>
    ipcRenderer.invoke('bundle:end', { id }) as Promise<
      { ok: true; share: Share } | { ok: false; error?: string }
    >,
  bundleAbort: (id: string) =>
    ipcRenderer.invoke('bundle:abort', { id }) as Promise<{ ok: boolean }>,

  listShares: () => ipcRenderer.invoke('shares:list') as Promise<Share[]>,
  deleteShare: (id: string) => ipcRenderer.invoke('shares:delete', id) as Promise<{ ok: boolean }>,
  setShareExpiry: (id: string, expiresAt: number | null) =>
    ipcRenderer.invoke('shares:setExpiry', { id, expiresAt }) as Promise<
      { ok: true; share: Share } | { ok: false }
    >,
  onSharesExpired: (cb: (ids: string[]) => void) => {
    const listener = (_e: IpcRendererEvent, ids: string[]): void => cb(ids)
    ipcRenderer.on('shares:expired', listener)
    return () => {
      ipcRenderer.removeListener('shares:expired', listener)
    }
  },

  // Live: neue Freigabe (z. B. hochgeladener Screenshot) im Hauptfenster ergänzen.
  onShareAdded: (cb: (share: Share) => void) => {
    const listener = (_e: IpcRendererEvent, share: Share): void => cb(share)
    ipcRenderer.on('shares:added', listener)
    return () => {
      ipcRenderer.removeListener('shares:added', listener)
    }
  },

  // ---- Screenshot-Aufnahme ----
  captureGet: () =>
    ipcRenderer.invoke('capture:get') as Promise<{
      enabled: boolean
      hotkey: string
      saveDir: string
      editorPath: string
      magnifier: boolean
      alwaysSave: boolean
      hotkeyActive: boolean
      /** Linux/Wayland: Aufnahme geht hier nicht (Hotkey bleibt frei). Sonst null. */
      unavailable: 'wayland' | null
    }>,
  captureSet: (patch: {
    enabled?: boolean
    hotkey?: string
    saveDir?: string
    editorPath?: string
    magnifier?: boolean
    alwaysSave?: boolean
  }) =>
    ipcRenderer.invoke('capture:set', patch) as Promise<{
      enabled: boolean
      hotkey: string
      saveDir: string
      editorPath: string
      magnifier: boolean
      alwaysSave: boolean
      hotkeyActive: boolean
      /** Linux/Wayland: Aufnahme geht hier nicht (Hotkey bleibt frei). Sonst null. */
      unavailable: 'wayland' | null
    }>,
  capturePickSaveDir: () =>
    ipcRenderer.invoke('capture:pickSaveDir') as Promise<{ ok: boolean; path?: string }>,
  capturePickEditor: () =>
    ipcRenderer.invoke('capture:pickEditor') as Promise<{ ok: boolean; path?: string }>,

  // Overlay-Fenster (Aufnahme):
  onCaptureInit: (
    cb: (data: {
      displayId: number
      scaleFactor: number
      bounds: { width: number; height: number }
      image: string
      windows: { x: number; y: number; width: number; height: number; title: string }[]
      magnifier: boolean
    }) => void
  ) => {
    const listener = (_e: IpcRendererEvent, data: Parameters<typeof cb>[0]): void => cb(data)
    ipcRenderer.on('capture:init', listener)
    return () => {
      ipcRenderer.removeListener('capture:init', listener)
    }
  },
  // Erkannte Fenster werden nachgereicht, sobald die Abfrage fertig ist.
  onCaptureWindows: (
    cb: (data: {
      windows: { x: number; y: number; width: number; height: number; title: string }[]
    }) => void
  ) => {
    const listener = (_e: IpcRendererEvent, data: Parameters<typeof cb>[0]): void => cb(data)
    ipcRenderer.on('capture:windows', listener)
    return () => {
      ipcRenderer.removeListener('capture:windows', listener)
    }
  },
  // Overlay wird nur versteckt (Fenster-Pool) – Zustand im Renderer zurücksetzen.
  onCaptureReset: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('capture:reset', listener)
    return () => {
      ipcRenderer.removeListener('capture:reset', listener)
    }
  },
  captureConfirm: (displayId: number, rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('capture:confirm', { displayId, rect }),
  // Renderer meldet, dass das neue Standbild gezeichnet ist (dann wird gezeigt).
  captureReady: (displayId: number) => ipcRenderer.send('capture:ready', displayId),
  captureCancel: () => ipcRenderer.send('capture:cancel'),

  // Aktionsfenster (nach der Aufnahme):
  onCaptureActionsInit: (
    cb: (data: { image: string; width: number; height: number }) => void
  ) => {
    const listener = (_e: IpcRendererEvent, data: Parameters<typeof cb>[0]): void => cb(data)
    ipcRenderer.on('capture:actions:init', listener)
    return () => {
      ipcRenderer.removeListener('capture:actions:init', listener)
    }
  },
  captureAction: (type: 'save' | 'edit' | 'copy' | 'upload') =>
    ipcRenderer.invoke('capture:action', type) as Promise<{
      ok: boolean
      url?: string
      error?: string
    }>,
  captureActionsClose: () => ipcRenderer.send('capture:actions:close'),

  settingsGet: () =>
    ipcRenderer.invoke('settings:get') as Promise<{
      defaultTtlHours: number
      closeToTray: boolean
      autostart: boolean
      scanUploads: boolean
      /** Gibt es einen Scanner (Defender/ClamAV)? Ohne ihn geht jeder Upload ungeprüft durch. */
      scannerFound: boolean
    }>,
  settingsSet: (patch: {
    defaultTtlHours?: number
    closeToTray?: boolean
    autostart?: boolean
    scanUploads?: boolean
  }) =>
    ipcRenderer.invoke('settings:set', patch) as Promise<{
      defaultTtlHours: number
      closeToTray: boolean
      autostart: boolean
      scanUploads: boolean
      scannerFound: boolean
    }>,

  serverInfo: () => ipcRenderer.invoke('server:info') as Promise<ServerInfo>,
  // Live-Update, wenn der Server zur Ruhe kommt oder wieder startet (Teilen nach Bedarf).
  onServerChanged: (cb: (info: ServerInfo) => void) => {
    const listener = (_e: IpcRendererEvent, info: ServerInfo): void => cb(info)
    ipcRenderer.on('server:changed', listener)
    return () => {
      ipcRenderer.removeListener('server:changed', listener)
    }
  },
  // ---- Links: Betriebsart (Relay / eigenes Netz / eigene Domain) und Zustand ----
  linksGet: () => ipcRenderer.invoke('links:get') as Promise<LinksInfo>,
  linksSet: (patch: { mode?: LinkMode; publicBaseUrl?: string; token?: string }) =>
    ipcRenderer.invoke('links:set', patch) as Promise<LinksInfo & { ok: boolean; error?: string }>,
  // Hinweis vor der ersten Anmeldung beim Relay bestätigen („Okay, Link erstellen“).
  linksAcceptRelay: () => ipcRenderer.invoke('links:acceptRelay') as Promise<LinksInfo>,
  linksTestDomain: () =>
    ipcRenderer.invoke('links:testDomain') as Promise<{
      ok: boolean
      target: string
      status?: number
      isThisServer?: boolean
      error?: string
    }>,
  onLinkStatus: (cb: (s: LinkStatus) => void) => {
    const listener = (_e: IpcRendererEvent, s: LinkStatus): void => cb(s)
    ipcRenderer.on('link:status', listener)
    return () => {
      ipcRenderer.removeListener('link:status', listener)
    }
  },
  // Alle Links neu (Betriebsart oder Geräte-ID gewechselt).
  onShareUrls: (cb: (urls: { id: string; url: string }[]) => void) => {
    const listener = (_e: IpcRendererEvent, urls: { id: string; url: string }[]): void => cb(urls)
    ipcRenderer.on('shares:urls', listener)
    return () => {
      ipcRenderer.removeListener('shares:urls', listener)
    }
  },

  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Renderer hat den ersten echten Inhalt gezeichnet (Start-Messung).
  appReady: () => ipcRenderer.send('window:app-ready'),

  appVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
  appInfo: () => ipcRenderer.invoke('app:info') as Promise<AppInfo>,

  // ---- Updates ----
  updatesGet: () => ipcRenderer.invoke('updates:get') as Promise<UpdatesInfo>,
  updatesSet: (patch: { auto?: boolean }) =>
    ipcRenderer.invoke('updates:set', patch) as Promise<UpdatesInfo>,
  updateGetStatus: () => ipcRenderer.invoke('update:status') as Promise<UpdateStatus>,
  updateCheck: () => ipcRenderer.invoke('update:check') as Promise<UpdateStatus>,
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => {
    const listener = (_e: IpcRendererEvent, s: UpdateStatus): void => cb(s)
    ipcRenderer.on('update:status', listener)
    return () => {
      ipcRenderer.removeListener('update:status', listener)
    }
  },

  // Oberflächen-Einstellungen (Theme/Vorschau/Banner) robust aus der Config lesen/
  // schreiben – überlebt einen localStorage-Verlust (harter Absturz/Kill). Lesen ist
  // synchron, damit das Theme schon vor dem ersten Zeichnen feststeht (kein Blitz).
  getUiPrefs: (): UiPrefs => ipcRenderer.sendSync('ui:get'),
  setUiPrefs: (patch: Partial<UiPrefs>) => ipcRenderer.send('ui:set', patch),

  // Eigene Titelleiste: Farben der nativen Fenster-Schaltflächen dem Theme anpassen.
  setTitleBarOverlay: (colors: { color: string; symbolColor: string }) =>
    ipcRenderer.send('window:titleBarOverlay', colors),

  // Dateisystempfad einer per Drag&Drop / Auswahl gewählten Datei (für Streaming-Upload).
  getFilePath: (file: File) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('foldwing', api)

export type FoldwingApi = typeof api
