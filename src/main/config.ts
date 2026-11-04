import { promises as fsp } from 'fs'
import { join } from 'path'
import { networkInterfaces } from 'os'

/** Wie Links entstehen: über den Relay, nur im eigenen Netz oder über die eigene Domain. */
export type LinkMode = 'relay' | 'lan' | 'domain'

export interface TunnelConfig {
  /** Tunnel-Token aus dem Cloudflare-Dashboard – nur im Modus 'domain'. */
  token: string
  /** Optionaler Pfad zur cloudflared-Executable (sonst automatische Erkennung). */
  cloudflaredPath: string
}

export interface RelayConfig {
  /** Geräte-ID (8 Zeichen base62), einmal pro Installation erzeugt; leer = noch keine. */
  deviceId: string
  /** Geheimnis zur Geräte-ID, per safeStorage verschlüsselt (siehe relay.ts). */
  secretEnc: string
  /**
   * Den Hinweis vor der ersten Anmeldung beim Relay hat die Person mit „Okay“
   * bestätigt. Vorher meldet sich die App nicht an.
   */
  noticeAccepted: boolean
}

export interface UpdatesConfig {
  /** Automatisch nach Updates suchen. */
  auto: boolean
}

export interface AppConfig {
  /** Port des eingebetteten Servers. */
  port: number
  linkMode: LinkMode
  relay: RelayConfig
  /** Eigener Cloudflare-Tunnel (Modus 'domain'). */
  tunnel: TunnelConfig
  /** Öffentliche Basis-URL im Modus 'domain' (z. B. https://share.example.com). */
  publicBaseUrl: string
  updates: UpdatesConfig
  /** Standard-Ablaufzeit neuer Freigaben in Stunden (0 = permanent). */
  defaultTtlHours: number
  /** Beim Schließen im Hintergrund (Tray) weiterlaufen – u. a. für den Screenshot-Hotkey. */
  closeToTray: boolean
  /** Beim Anmelden starten (still im Infobereich, ohne Fenster). */
  autostart: boolean
  /** Interne Versionsnummer für einmalige Migrationen. */
  configVersion: number
  /** Uploads vor der Freigabe lokal auf Schadsoftware prüfen (Defender/ClamAV). */
  scanUploads: boolean
  /** Screenshot-Aufnahme (systemweiter Hotkey). */
  capture: CaptureConfig
  /**
   * Robuste Kopie der Oberflächen-Einstellungen. Diese liegen zwar im localStorage
   * des Renderers, der aber bei einem harten Absturz/Kill verloren gehen kann –
   * daher hier gespiegelt und beim Start wiederhergestellt, falls localStorage leer.
   */
  ui: UiConfig
}

export interface UiConfig {
  theme: 'light' | 'dark'
  previews: boolean
  bannerDismissed: boolean
}

export interface CaptureConfig {
  enabled: boolean
  /** Globaler Hotkey im Electron-Accelerator-Format (z. B. "PrintScreen"). */
  hotkey: string
  /** Zielordner zum Speichern (leer = Bilder/Foldwing). */
  saveDir: string
  /** Pfad zur externen Bildbearbeitung (leer = „Öffnen mit" bzw. Standard-App). */
  editorPath: string
  /** Pixel-Lupe am Cursor während der Auswahl anzeigen. */
  magnifier: boolean
  /** Jeden Screenshot zusätzlich im Speicherordner ablegen – auch beim Hochladen/Kopieren. */
  alwaysSave: boolean
}

export const CONFIG_VERSION = 3

export const DEFAULTS: AppConfig = {
  port: 8787,
  linkMode: 'relay',
  relay: { deviceId: '', secretEnc: '', noticeAccepted: false },
  tunnel: { token: '', cloudflaredPath: '' },
  publicBaseUrl: '',
  updates: { auto: true },
  defaultTtlHours: 0,
  closeToTray: true,
  autostart: true,
  configVersion: CONFIG_VERSION,
  scanUploads: true,
  capture: {
    enabled: true,
    hotkey: 'PrintScreen',
    saveDir: '',
    editorPath: '',
    magnifier: true,
    alwaysSave: false
  },
  ui: { theme: 'light', previews: true, bannerDismissed: false }
}

/**
 * Abgeschaffte Schlüssel. Die Migration übernimmt nur bekannte Schlüssel, alles hier
 * fällt also beim Laden weg und die Datei wird ohne sie zurückgeschrieben:
 * `provisioning.apiTokenEnc` enthielt einen verschlüsselten Cloudflare-API-Token,
 * `license` den Zugangs-Token der früheren Zugangs-Sperre, `deviceId` deren
 * Geräte-Kennung; `serverInBackground` und `contextMenuPath` braucht niemand mehr.
 * Seit 1.4.0 entfallen Team-Modus (`teamName`) und benannter Tunnel
 * (`tunnel.mode`, `tunnel.name`, `tunnel.enabled`).
 */
export const RETIRED_KEYS = [
  'provisioning',
  'remote',
  'uploadKey',
  'maxUploadMB',
  'license',
  'deviceId',
  'serverInBackground',
  'contextMenuPath',
  'teamName',
  'tunnel.mode',
  'tunnel.name',
  'tunnel.enabled'
] as const

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Betriebsart einer Config aus der Zeit vor 1.4.0 ableiten. */
function legacyLinkMode(p: Obj): LinkMode {
  // Team-Mitglieder liefen über eine Subdomain des Teams – die gibt es nicht mehr.
  if (str(p['teamName'], '').trim()) return 'relay'
  const t = isObj(p['tunnel']) ? p['tunnel'] : {}
  const token = str(t['token'], '').trim()
  const base = str(p['publicBaseUrl'], '').trim()
  if (token && base) return 'domain'
  return 'relay'
}

/**
 * Rohen Datei-Inhalt in eine gültige Config überführen. Rein (keine Platte), damit
 * testbar. `changed` sagt, ob die Datei zurückgeschrieben werden sollte.
 */
export function migrateConfig(parsed: unknown): { config: AppConfig; changed: boolean } {
  const p: Obj = isObj(parsed) ? parsed : {}
  const version = num(p['configVersion'], 0)
  const t = isObj(p['tunnel']) ? p['tunnel'] : {}
  const r = isObj(p['relay']) ? p['relay'] : {}
  const u = isObj(p['updates']) ? p['updates'] : {}
  const c = isObj(p['capture']) ? p['capture'] : {}
  const ui = isObj(p['ui']) ? p['ui'] : {}
  const D = DEFAULTS

  let linkMode: LinkMode
  let token = str(t['token'], D.tunnel.token)
  let publicBaseUrl = str(p['publicBaseUrl'], D.publicBaseUrl)
  if (version < 3) {
    linkMode = legacyLinkMode(p)
    if (str(p['teamName'], '').trim()) {
      // Team-Token und Team-Adresse gehören dem Team, nicht dieser Installation.
      token = ''
      publicBaseUrl = ''
    }
  } else {
    const m = p['linkMode']
    linkMode = m === 'lan' || m === 'domain' || m === 'relay' ? m : D.linkMode
  }

  const deviceId = str(r['deviceId'], '')
  const config: AppConfig = {
    port: Math.round(num(p['port'], D.port)),
    linkMode,
    relay: {
      deviceId: /^[A-Za-z0-9]{8}$/.test(deviceId) ? deviceId : '',
      secretEnc: str(r['secretEnc'], ''),
      noticeAccepted: bool(r['noticeAccepted'], D.relay.noticeAccepted)
    },
    tunnel: { token, cloudflaredPath: str(t['cloudflaredPath'], D.tunnel.cloudflaredPath) },
    publicBaseUrl,
    updates: { auto: bool(u['auto'], D.updates.auto) },
    defaultTtlHours: num(p['defaultTtlHours'], D.defaultTtlHours),
    // Seit dem Screenshot-Feature (Config v2) bleibt die App standardmäßig im
    // Hintergrund aktiv – ältere Configs ohne Version werden einmalig angehoben.
    closeToTray: version < 2 ? true : bool(p['closeToTray'], D.closeToTray),
    autostart: bool(p['autostart'], D.autostart),
    configVersion: CONFIG_VERSION,
    scanUploads: bool(p['scanUploads'], D.scanUploads),
    capture: {
      enabled: bool(c['enabled'], D.capture.enabled),
      hotkey: str(c['hotkey'], D.capture.hotkey),
      saveDir: str(c['saveDir'], D.capture.saveDir),
      editorPath: str(c['editorPath'], D.capture.editorPath),
      magnifier: bool(c['magnifier'], D.capture.magnifier),
      alwaysSave: bool(c['alwaysSave'], D.capture.alwaysSave)
    },
    ui: {
      theme: ui['theme'] === 'dark' ? 'dark' : 'light',
      previews: bool(ui['previews'], D.ui.previews),
      bannerDismissed: bool(ui['bannerDismissed'], D.ui.bannerDismissed)
    }
  }
  if (config.relay.deviceId === '') config.relay.secretEnc = ''

  // Zurückschreiben, wenn sich am Inhalt etwas geändert hat (Version, Reste,
  // ungültige Werte). Vergleich über die kanonische Form, unabhängig von der Reihenfolge.
  const changed = canonical(p) !== canonical(config as unknown as Obj)
  return { config, changed }
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

function cloneDefaults(): AppConfig {
  return migrateConfig({ configVersion: CONFIG_VERSION }).config
}

/** Name der Config-Datei im Datenordner. */
export const CONFIG_FILE = 'foldwing-config.json'

export class ConfigStore {
  private path: string
  private cache: AppConfig = cloneDefaults()

  constructor(dir: string) {
    this.path = join(dir, CONFIG_FILE)
  }

  async load(): Promise<AppConfig> {
    let raw: string
    try {
      raw = await fsp.readFile(this.path, 'utf-8')
    } catch {
      this.cache = cloneDefaults()
      return this.cache
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.cache = cloneDefaults()
      return this.cache
    }
    const { config, changed } = migrateConfig(parsed)
    this.cache = config
    if (changed) {
      try {
        await this.patch({}) // bereinigten Stand atomar zurückschreiben
      } catch {
        // Nicht schreibbar -> beim nächsten Start erneut. Nicht nach oben
        // durchreichen, sonst gingen alle Einstellungen verloren.
      }
    }
    return this.cache
  }

  get(): AppConfig {
    return this.cache
  }

  async patch(patch: Partial<AppConfig>): Promise<AppConfig> {
    this.cache = { ...this.cache, ...patch }
    // Atomar schreiben (Temp + Rename), damit ein Absturz mitten im Schreiben die
    // Config nicht zu einer halben/kaputten Datei macht – sonst wären beim nächsten
    // Start ALLE Einstellungen weg. Rename ist auf demselben Volume atomar.
    const tmp = this.path + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(this.cache, null, 2))
    await fsp.rename(tmp, this.path)
    return this.cache
  }
}

/** Netzwerkkarten, die selten das echte Heimnetz sind (Hyper-V/WSL, VMs, VPNs). */
const VIRTUAL_IFACE = /vethernet|wsl|hyper-v|virtualbox|vmware|vbox|docker|tailscale|zerotier|wireguard|vpn|loopback/i

/**
 * Beste IPv4-Adresse fürs eigene Netz – rein, damit testbar. Private Adressen
 * (192.168/16, 10/8, 172.16/12) auf echten Karten zuerst, dann private auf
 * virtuellen, dann der Rest. Link-lokale 169.254.x.x (kein DHCP) taugen nie.
 */
export function pickLanAddress(
  ifaces: Record<string, { family: string | number; address: string; internal: boolean }[] | undefined>
): string | null {
  const isPrivate = (a: string): boolean =>
    /^192\.168\./.test(a) || /^10\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
  let best: { rank: number; address: string } | null = null
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      const v4 = net.family === 'IPv4' || net.family === 4
      if (!v4 || net.internal || /^169\.254\./.test(net.address)) continue
      const rank = (isPrivate(net.address) ? 0 : 2) + (VIRTUAL_IFACE.test(name) ? 1 : 0)
      if (!best || rank < best.rank) best = { rank, address: net.address }
    }
  }
  return best?.address ?? null
}

/** IPv4-Adresse für einen brauchbaren LAN-Link. */
export function detectLanAddress(): string | null {
  return pickLanAddress(networkInterfaces())
}
