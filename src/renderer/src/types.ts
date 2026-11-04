/** MIME einer Sammel-Freigabe (mehrere Dateien, ein Link) – siehe src/main/store.ts. */
export const BUNDLE_MIME = 'application/x-foldwing-bundle'

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
  /** Portable/.deb: neue Version da, Installation von Hand. */
  | { state: 'manual'; version: string }
  | { state: 'none' }
  | { state: 'error'; message: string }
  /** Dev-Lauf oder entpackter Test-Build – es wird nie geprüft. */
  | { state: 'disabled' }

// Spiegel der Typen aus src/preload/index.ts (der Renderer kennt die Brücke nur über window.foldwing).
export type LinkMode = 'relay' | 'lan' | 'domain'

export type LinkState =
  | 'resting'
  | 'waiting'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'blocked'
  | 'error'

export interface LinkStatus {
  mode: LinkMode
  state: LinkState
  text: string
}

export interface LinksInfo {
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
  mode: 'auto' | 'manual' | 'none'
  releasesUrl: string
}

export type UploadStatus = 'uploading' | 'done' | 'failed'

/** Ein Eintrag im Verlauf: entweder ein laufender Upload oder eine fertige Freigabe. */
export interface ShareItem {
  id: string
  name: string
  mime: string
  size: number
  createdAt: number
  expiresAt?: number
  status: UploadStatus
  progress: number // 0..1
  url?: string
  previewUrl?: string // blob-URL für frisch hochgeladene Medien
  error?: string
  /**
   * Nur bei Sammlungen (mehrere Dateien, ein Link): die enthaltenen Dateien für
   * die Anzeige in der Karte. `previewUrl` ist die blob-URL frisch hochgeladener
   * Bilder/Videos und muss beim Entfernen wieder freigegeben werden.
   */
  files?: { fid?: string; name: string; mime: string; size: number; previewUrl?: string }[]
}
