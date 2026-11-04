import { spawn, ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import { isLinux, isWindows } from './platform'
import { parseQuickTunnelUrl } from './relay'
import { APP_NAME } from './brand'

export type TunnelStatus = 'off' | 'starting' | 'connected' | 'error'

export interface TunnelState {
  status: TunnelStatus
  detail: string
  cloudflaredFound: boolean
  /** Nur Quick Tunnel: die von Cloudflare vergebene Adresse, sobald bekannt. */
  url?: string
}

export type TunnelRunOptions =
  /** Quick Tunnel ohne Konto (Relay-Modus): Adresse kommt aus der Ausgabe. */
  | { mode: 'quick'; port: number; configPath: string; cloudflaredPath?: string }
  /** Eigener Tunnel per Token aus dem Cloudflare-Dashboard (Modus „eigene Domain“). */
  | { mode: 'token'; token: string; cloudflaredPath?: string }

/** Plattformgerechter Binärname: cloudflared.exe (Windows) bzw. cloudflared (Linux). */
const CLOUDFLARED_BIN = isWindows ? 'cloudflared.exe' : 'cloudflared'

const COMMON_PATHS = isWindows
  ? [
      'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      'C:\\Program Files\\cloudflared\\cloudflared.exe'
    ]
  : [
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      '/snap/bin/cloudflared',
      join(homedir(), '.local', 'bin', 'cloudflared')
    ]

/** Findet die cloudflared-Executable (Override, gebündelt, Standardpfade, WinGet, PATH). */
export function detectCloudflared(override?: string): string | null {
  const candidates: string[] = []
  if (override) candidates.push(override)
  // In der gepackten App mitgeliefertes cloudflared (extraResources).
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, CLOUDFLARED_BIN))
  candidates.push(...COMMON_PATHS)
  if (isWindows) {
    const local = process.env.LOCALAPPDATA
    if (local) candidates.push(join(local, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'))
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.trim()) candidates.push(join(dir.trim(), CLOUDFLARED_BIN))
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Inhalt der eigenen Config für den Quick Tunnel. cloudflared liest sonst
 * ~/.cloudflared/config.yml (z. B. von einem früher eingerichteten benannten
 * Tunnel) und übernimmt daraus Zugangsdatei und Einstellungen – je nach Version
 * verweigert es den Quick Tunnel dann ganz. Eine leere Datei meldet cloudflared
 * als Fehler („was empty“), deshalb steht ein harmloser Schlüssel drin.
 */
export const QUICK_TUNNEL_CONFIG =
  '# Von Foldwing angelegt: eigene Config für den Quick Tunnel.\nno-autoupdate: true\n'

/** Eigene Config-Datei für den Quick Tunnel anlegen (idempotent). */
export function ensureQuickTunnelConfig(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, QUICK_TUNNEL_CONFIG, 'utf8')
}

/** Kommandozeile für cloudflared – rein, damit testbar. */
export function cloudflaredArgs(opts: TunnelRunOptions): string[] {
  if (opts.mode === 'quick') {
    return [
      'tunnel',
      '--no-autoupdate',
      '--config',
      opts.configPath,
      '--url',
      `http://127.0.0.1:${opts.port}`
    ]
  }
  return ['tunnel', '--no-autoupdate', 'run', '--token', opts.token.trim()]
}

/**
 * Meldung aus einer Fehlerzeile der cloudflared-Ausgabe – oder null, wenn die
 * Ausgabe keinen echten Fehler enthält. Ohne Zeitstempel, Pfade und Tokens.
 */
export function cloudflaredErrorLine(text: string): string | null {
  const line = text.split('\n').find((l) => /\sERR\s|failed to|unauthorized/i.test(l))
  if (!line) return null
  return line
    .replace(/^\S+Z\s+ERR\s+/, '')
    .replace(/eyJ[A-Za-z0-9+/_=-]+/g, '…')
    .replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"]+|\/(?:home|Users)\/[^\s"]+/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

/**
 * Startet und überwacht den cloudflared-Connector als Kindprozess. Damit reicht
 * die geöffnete App aus, um die Verbindung zu halten – kein separates Terminal
 * und kein Windows-Dienst nötig. Beim Beenden der App wird der Tunnel
 * mitbeendet (die Links sind dann bewusst offline).
 */
export class TunnelManager {
  private child: ChildProcess | null = null
  private wantRunning = false
  private restartTimer: NodeJS.Timeout | null = null
  private opts: TunnelRunOptions | null = null
  private state: TunnelState = { status: 'off', detail: 'Aus', cloudflaredFound: false }
  // Linux: pro Start-Anlauf nur einmal automatisch auf EACCES reagieren (chmod
  // + Neuversuch), damit ein dauerhaft kaputtes Binary nicht endlos neu startet.
  private eaccesRetried = false
  private restarts = 0

  constructor(private onState: (s: TunnelState) => void) {
    this.state.cloudflaredFound = detectCloudflared() !== null
  }

  getState(): TunnelState {
    return this.state
  }

  /** Mit welcher Betriebsart läuft (oder startet) der Tunnel gerade? */
  runningMode(): TunnelRunOptions['mode'] | null {
    return this.wantRunning && this.opts ? this.opts.mode : null
  }

  private set(status: TunnelStatus, detail: string, url?: string): void {
    this.state = { status, detail, cloudflaredFound: this.state.cloudflaredFound, url }
    this.onState(this.state)
  }

  start(opts: TunnelRunOptions): void {
    // Ein schon laufender cloudflared (oder ein anstehender Neustart) muss erst weg –
    // sonst bleibt der alte Prozess als Waise zurück und überlebt sogar das Beenden der App.
    this.killChild()
    this.opts = opts
    this.wantRunning = true
    this.eaccesRetried = false
    this.restarts = 0
    this.spawnProc()
  }

  stop(): void {
    this.wantRunning = false
    this.killChild()
    this.set('off', 'Aus')
  }

  /** Laufenden Kindprozess und geplanten Neustart beenden. */
  private killChild(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.child) {
      const old = this.child
      // Zuerst entkoppeln: der exit-Handler des alten Prozesses prüft `this.child !== child`
      // und plant dann keinen Neustart mehr.
      this.child = null
      old.kill()
    }
  }

  private spawnProc(): void {
    const opts = this.opts
    if (!opts) return
    const bin = detectCloudflared(opts.cloudflaredPath)
    this.state.cloudflaredFound = bin !== null
    if (!bin) {
      this.set('error', `Ein Programmteil fehlt (cloudflared). Installier ${APP_NAME} neu oder leg cloudflared in den PATH.`)
      return
    }
    if (opts.mode === 'token' && !opts.token.trim()) {
      return this.set('error', 'Kein Tunnel-Token hinterlegt.')
    }
    if (opts.mode === 'quick') {
      try {
        ensureQuickTunnelConfig(opts.configPath)
      } catch (e) {
        return this.set('error', `Tunnel-Einstellungen ließen sich nicht anlegen: ${(e as Error).message}`)
      }
    }

    this.set('starting', 'Verbinde mit Cloudflare …')

    let child: ChildProcess
    try {
      child = spawn(bin, cloudflaredArgs(opts), { windowsHide: true })
    } catch (e) {
      return this.set('error', `Start fehlgeschlagen: ${(e as Error).message}`)
    }
    this.child = child
    let quickUrl: string | undefined

    const onData = (buf: Buffer): void => {
      if (this.child !== child) return
      const text = buf.toString()
      if (opts.mode === 'quick' && !quickUrl) {
        const u = parseQuickTunnelUrl(text)
        if (u) {
          quickUrl = u
          // Adresse steht, Verbindung meist noch nicht – 'starting' mit Adresse.
          if (this.state.status !== 'connected') this.set('starting', 'Verbinde mit Cloudflare …', u)
        }
      }
      if (/Registered tunnel connection|Connection [a-z0-9-]+ registered/i.test(text)) {
        // Ohne Adresse nützt eine Verbindung im Quick-Modus nichts.
        if (opts.mode === 'quick' && !quickUrl) return
        this.restarts = 0
        this.set('connected', 'Mit Cloudflare verbunden.', quickUrl)
      } else if (this.state.status !== 'connected') {
        const err = cloudflaredErrorLine(text)
        if (err) this.set('error', err, quickUrl)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('error', (e) => {
      // Nur reagieren, wenn dieser Kindprozess noch der aktuelle ist – nicht ein
      // längst abgelöster aus einem vorherigen Versuch (siehe Neuversuch unten).
      if (this.child !== child) return
      const code = (e as NodeJS.ErrnoException).code
      // Linux: das Binary kann ohne Ausführungsrecht ankommen (z. B. von einer mit
      // Windows geteilten Platte kopiert, oder das x-Bit hängt an Mount-Optionen)
      // -> einmal reparieren und den Start genau einmal automatisch wiederholen.
      if (isLinux && code === 'EACCES' && !this.eaccesRetried) {
        this.eaccesRetried = true
        this.child = null
        try {
          chmodSync(bin, 0o755)
        } catch {
          /* chmod fehlgeschlagen -> der Neuversuch scheitert dann gleich wieder */
        }
        this.spawnProc()
        return
      }
      // Hinweis nur unter Linux ergänzen -> Windows-Fehlertext bleibt unverändert.
      const hint = isLinux && code === 'EACCES' ? ' – cloudflared ist nicht ausführbar.' : ''
      this.set('error', `cloudflared-Fehler: ${e.message}${hint}`)
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      if (this.wantRunning) {
        // Ein Quick Tunnel bekommt beim Neustart eine NEUE Adresse – der Zustand
        // ohne url sagt der Relay-Anmeldung, dass die alte nicht mehr gilt.
        this.set('error', `Verbindung getrennt (Code ${code ?? '?'}). Neuer Versuch …`)
        // Sanft wachsender Abstand, damit ein dauerhaft scheiterndes cloudflared
        // nicht im Sekundentakt neu startet.
        const wait = Math.min(4000 * 2 ** this.restarts, 120_000)
        this.restarts++
        this.restartTimer = setTimeout(() => {
          if (this.wantRunning) this.spawnProc()
        }, wait)
      }
    })
  }
}
