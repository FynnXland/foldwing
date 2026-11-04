/**
 * Relay-Modus – elektronfreie Client-Logik (getestet in tests/relay.test.ts).
 *
 * Links laufen über einen öffentlichen Relay (`https://foldwing.online/<T>`), der
 * keine Dateien speichert, sondern nur weiß, unter welcher Quick-Tunnel-Adresse
 * ein Gerät gerade erreichbar ist. `T` ist Geräte-ID (8 Zeichen) + Freigabe-ID
 * (10 Zeichen). Die App meldet sich mit Geräte-ID und Geheimnis an, sobald ihr
 * Tunnel steht, und wieder ab, wenn nichts mehr geteilt ist.
 *
 * Alles, was Electron braucht (safeStorage, Timer der App), kommt per Injektion
 * herein, damit sich Backoff, Heartbeat und Antwort-Auswertung ohne App testen
 * lassen.
 */
import { randomBytes } from 'crypto'

/** Öffentlicher Standard-Relay. */
export const DEFAULT_RELAY_URL = 'https://foldwing.online'

/** Seiten des Relays, auf die die App verlinkt (Kurzwege, der Relay leitet weiter). */
export const RELAY_INFO_PATH = '/_/'
export const RELAY_RULES_PATH = '/_/regeln'
export const RELAY_PRIVACY_PATH = '/_/datenschutz'
export const RELAY_IMPRINT_PATH = '/_/impressum'

export const DEVICE_ID_RE = /^[A-Za-z0-9]{8}$/
export const SHARE_ID_RE = /^[A-Za-z0-9]{10}$/
export const FILE_ID_RE = /^[A-Za-z0-9]{6}$/
/** Lange ID im Link: Geräte-ID + Freigabe-ID. */
export const TOKEN_RE = /^[A-Za-z0-9]{18}$/
/** Geheimnis: 32 Zufallsbytes als base64url ohne Auffüllung = 43 Zeichen. */
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/
/** Genau die Form, die der Relay annimmt. */
export const QUICK_TUNNEL_URL_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/

/** Heartbeat: so oft meldet sich die App erneut an, solange der Tunnel läuft. */
export const HEARTBEAT_MS = 6 * 3_600_000
/** Backoff bei 429, 5xx und Netzfehlern. Danach bleibt es beim letzten Wert. */
export const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000] as const
/** 422: Der Relay erreicht den Tunnel (noch) nicht – kurz warten, höchstens 5-mal. */
export const UNREACHABLE_RETRY_MS = 15_000
export const UNREACHABLE_MAX_TRIES = 5
/** Selbsttest vor der Anmeldung: so lange auf den eigenen Tunnel warten. */
export const SELFTEST_TIMEOUT_MS = 90_000
export const SELFTEST_INTERVAL_MS = 2_000
/** Zeitlimit je Anfrage an den Relay. */
export const REQUEST_TIMEOUT_MS = 15_000

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Gleichverteilter base62-Code (Ablehnungsverfahren, kein Modulo-Bias). */
export function randomBase62(length: number, rand: (n: number) => Buffer = randomBytes): string {
  let out = ''
  while (out.length < length) {
    for (const b of rand(length * 2)) {
      // 248 = 4 * 62: alles darüber verwerfen, sonst kämen die ersten Zeichen öfter.
      if (b < 248) out += BASE62[b % 62]
      if (out.length === length) break
    }
  }
  return out
}

export function makeDeviceId(rand?: (n: number) => Buffer): string {
  return randomBase62(8, rand)
}

export function makeSecret(rand: (n: number) => Buffer = randomBytes): string {
  return rand(32).toString('base64url')
}

/**
 * Relay-Basis: Standard ist foldwing.online. Nur für Tests und Entwicklung per
 * FOLDWING_RELAY_URL überschreibbar; Unbrauchbares fällt auf den Standard zurück.
 */
export function relayBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env['FOLDWING_RELAY_URL'] ?? '').trim()
  if (!raw) return DEFAULT_RELAY_URL
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return DEFAULT_RELAY_URL
    if (u.username || u.password || u.search || u.hash) return DEFAULT_RELAY_URL
    return (u.origin + u.pathname).replace(/\/+$/, '')
  } catch {
    return DEFAULT_RELAY_URL
  }
}

/** Kopierbarer Link einer Freigabe im Relay-Modus. */
export function relayShareUrl(base: string, deviceId: string, shareId: string): string {
  return `${base.replace(/\/+$/, '')}/${deviceId}${shareId}`
}

/** T in Geräte- und Freigabe-ID zerlegen; null, wenn es kein gültiges T ist. */
export function splitToken(token: string): { deviceId: string; shareId: string } | null {
  if (!TOKEN_RE.test(token)) return null
  return { deviceId: token.slice(0, 8), shareId: token.slice(8) }
}

/** Adresse des Quick Tunnels aus einer Zeile der cloudflared-Ausgabe lesen. */
export function parseQuickTunnelUrl(text: string): string | null {
  for (const m of text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com(?![a-z0-9.-])/g)) {
    // api.trycloudflare.com ist der Dienst, der Tunnel vergibt – nie unsere Adresse.
    if (m[1] === 'api') continue
    return `https://${m[1]}.trycloudflare.com`
  }
  return null
}

// ---- Geheimnis verschlüsselt ablegen ----------------------------------------

/** Die Teile von Electrons safeStorage, die hier gebraucht werden. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(enc: Buffer): string
}

const SAFE_PREFIX = 'safe:'
const PLAIN_PREFIX = 'b64:'

/**
 * Mit safeStorage verschlüsseln; ist das nicht verfügbar (Linux ohne Schlüsselbund),
 * als base64 mit Kennzeichen ablegen – dann ist es ehrlich als unverschlüsselt markiert.
 */
export function encodeSecret(secret: string, cipher: SecretCipher | null): string {
  try {
    if (cipher?.isEncryptionAvailable()) {
      return SAFE_PREFIX + cipher.encryptString(secret).toString('base64')
    }
  } catch {
    /* fällt auf base64 zurück */
  }
  return PLAIN_PREFIX + Buffer.from(secret, 'utf8').toString('base64')
}

/** Gegenstück zu encodeSecret; null, wenn es sich nicht (mehr) lesen lässt. */
export function decodeSecret(enc: string, cipher: SecretCipher | null): string | null {
  try {
    let plain: string | null = null
    if (enc.startsWith(SAFE_PREFIX)) {
      if (!cipher?.isEncryptionAvailable()) return null
      plain = cipher.decryptString(Buffer.from(enc.slice(SAFE_PREFIX.length), 'base64'))
    } else if (enc.startsWith(PLAIN_PREFIX)) {
      plain = Buffer.from(enc.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
    }
    return plain && SECRET_RE.test(plain) ? plain : null
  } catch {
    return null
  }
}

// ---- Antworten des Relays auswerten -----------------------------------------

export type RegisterOutcome =
  | { kind: 'ok' }
  /** 409: Die Geräte-ID gehört (inzwischen) jemand anderem. */
  | { kind: 'taken' }
  /** 403: Das Gerät ist gesperrt. */
  | { kind: 'blocked' }
  /** 422: Der Relay erreicht unseren Tunnel (noch) nicht. */
  | { kind: 'unreachable' }
  /** 429, 5xx, Netzfehler, Timeout: später erneut. */
  | { kind: 'retry' }
  /** 400 und alles Unerwartete: Neuversuch hilft nicht. */
  | { kind: 'invalid'; status: number }

/** `status` null heißt: keine Antwort (Netzfehler oder Timeout). */
export function interpretRegisterResponse(status: number | null, body: unknown): RegisterOutcome {
  if (status === null) return { kind: 'retry' }
  const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  if (status >= 200 && status < 300) {
    const ok = body && typeof body === 'object' ? (body as { ok?: unknown }).ok : undefined
    return ok === true ? { kind: 'ok' } : { kind: 'retry' }
  }
  if (status === 409 || err === 'taken') return { kind: 'taken' }
  if (status === 403 || err === 'blocked') return { kind: 'blocked' }
  if (status === 422) return { kind: 'unreachable' }
  if (status === 429 || status >= 500) return { kind: 'retry' }
  return { kind: 'invalid', status }
}

/** Wartezeit vor dem nächsten Versuch nach `attempt` (0 = erster) Fehlschlägen. */
export function retryDelay(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(0, attempt), RETRY_BACKOFF_MS.length - 1)]
}

// ---- Der Client ------------------------------------------------------------

export type RelayState =
  /** Nicht verbunden, nichts zu tun. */
  | 'idle'
  /** Selbsttest und Anmeldung laufen. */
  | 'connecting'
  /** Angemeldet, Links funktionieren. */
  | 'online'
  /** Gerade nicht angemeldet, ein Neuversuch ist geplant. */
  | 'offline'
  /** Gerät vom Relay gesperrt. */
  | 'blocked'
  /** Neuversuch hilft nicht (z. B. unerwartete Antwort). */
  | 'error'

export interface RelayStatus {
  state: RelayState
  /** Kurzer, menschlicher Text für die Oberfläche. */
  text: string
  /** Zeitpunkt des nächsten Versuchs (nur bei 'offline'). */
  retryAt?: number
}

export interface RelayIdentity {
  deviceId: string
  secret: string
}

export interface FetchLike {
  (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{
    status: number
    json(): Promise<unknown>
  }>
}

export interface RelayDeps {
  baseUrl: string
  version: string
  fetch: FetchLike
  /** Aktuelle Identität (wird bei Bedarf angelegt). */
  identity: () => RelayIdentity
  /** Neue Identität erzeugen und speichern (nach 409). */
  renewIdentity: () => RelayIdentity
  onStatus: (s: RelayStatus) => void
  /** Timer – in Tests ersetzbar. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  now?: () => number
}

const TEXTS = {
  idle: 'Ruht, bis du etwas teilst.',
  selftest: 'Verbinde …',
  register: 'Anmeldung bei foldwing.online …',
  online: 'Online. Deine Links funktionieren.',
  offline: 'Gerade offline. Gleich kommt ein neuer Versuch.',
  unreachable: 'Dein Rechner ist von außen noch nicht erreichbar. Ein neuer Versuch läuft.',
  blocked:
    'Dieses Gerät ist für foldwing.online gesperrt, deshalb gibt es gerade keine Internet-Links. Im eigenen Netzwerk kannst du weiter teilen.',
  taken: 'Die Anmeldung bei foldwing.online hat nicht geklappt.',
  invalid: 'foldwing.online hat die Anmeldung abgelehnt.'
}

/**
 * Hält die Anmeldung beim Relay für EINE Tunnel-Adresse aufrecht: Selbsttest,
 * Anmeldung, Neuversuche mit Backoff, Heartbeat. `connect()` mit einer neuen
 * Adresse ersetzt die alte; `disconnect()` meldet ab und räumt alle Timer.
 */
export class RelayClient {
  private status: RelayStatus = { state: 'idle', text: TEXTS.idle }
  private tunnelUrl: string | null = null
  private timer: unknown = null
  /** Wechselt bei jedem connect/disconnect – alte asynchrone Läufe erkennen sich daran. */
  private generation = 0
  private registered = false
  private retryAttempt = 0
  private unreachableTries = 0
  private renewed = false

  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (t: unknown) => void
  private readonly now: () => number

  constructor(private deps: RelayDeps) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        ;(t as { unref?: () => void }).unref?.()
        return t
      })
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
    this.now = deps.now ?? Date.now
  }

  getStatus(): RelayStatus {
    return this.status
  }

  isRegistered(): boolean {
    return this.registered
  }

  currentTunnelUrl(): string | null {
    return this.tunnelUrl
  }

  private set(s: RelayStatus): void {
    this.status = s
    this.deps.onStatus(s)
  }

  private schedule(fn: () => void, ms: number): void {
    this.cancelTimer()
    const gen = this.generation
    this.timer = this.setTimer(() => {
      this.timer = null
      if (gen === this.generation) fn()
    }, ms)
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  /** Mit einer (neuen) Tunnel-Adresse anmelden. Gleiche Adresse: nichts tun. */
  connect(tunnelUrl: string): void {
    if (this.tunnelUrl === tunnelUrl && this.status.state !== 'idle') return
    this.generation++
    this.cancelTimer()
    this.tunnelUrl = tunnelUrl
    this.registered = false
    this.retryAttempt = 0
    this.unreachableTries = 0
    this.renewed = false
    if (!QUICK_TUNNEL_URL_RE.test(tunnelUrl)) {
      this.set({ state: 'error', text: 'Die Tunnel-Adresse sieht ungültig aus.' })
      return
    }
    this.set({ state: 'connecting', text: TEXTS.selftest })
    void this.selfTestThenRegister(this.generation)
  }

  /**
   * Abmelden (falls angemeldet) und alles anhalten. Wartet höchstens
   * `timeoutMs` auf den Relay – beim Beenden darf das nicht hängen.
   */
  async disconnect(timeoutMs = 5_000): Promise<void> {
    this.generation++
    this.cancelTimer()
    const wasRegistered = this.registered
    this.registered = false
    this.tunnelUrl = null
    if (this.status.state !== 'idle') this.set({ state: 'idle', text: TEXTS.idle })
    if (!wasRegistered) return
    let id: RelayIdentity
    try {
      id = this.deps.identity()
    } catch {
      return
    }
    await this.post('/_/api/unregister', { id: id.deviceId, secret: id.secret }, timeoutMs)
  }

  /** Eigener Tunnel muss /api/health mit unserer Geräte-ID beantworten. */
  private async selfTestThenRegister(gen: number): Promise<void> {
    const url = this.tunnelUrl
    if (!url) return
    const deadline = this.now() + SELFTEST_TIMEOUT_MS
    for (;;) {
      if (gen !== this.generation) return
      const ok = await this.selfTest(url)
      if (gen !== this.generation) return
      if (ok) break
      if (this.now() >= deadline) {
        this.retryLater(gen, TEXTS.unreachable)
        return
      }
      await new Promise<void>((r) => this.schedule(r, SELFTEST_INTERVAL_MS))
    }
    if (gen !== this.generation) return
    await this.register(gen)
  }

  private async selfTest(url: string): Promise<boolean> {
    let deviceId: string
    try {
      deviceId = this.deps.identity().deviceId
    } catch {
      return false
    }
    const res = await this.request(`${url}/api/health`, { method: 'GET' }, 8_000)
    if (!res || res.status !== 200) return false
    const j = res.body as { app?: unknown; device?: unknown } | null
    return !!j && j.app === 'Foldwing' && j.device === deviceId
  }

  private async register(gen: number): Promise<void> {
    const url = this.tunnelUrl
    if (!url || gen !== this.generation) return
    if (this.status.state !== 'online') this.set({ state: 'connecting', text: TEXTS.register })
    let id: RelayIdentity
    try {
      id = this.deps.identity()
    } catch {
      this.set({ state: 'error', text: 'Die Geräte-Kennung ließ sich nicht laden.' })
      return
    }
    const res = await this.post(
      '/_/api/register',
      { id: id.deviceId, secret: id.secret, url, version: this.deps.version },
      REQUEST_TIMEOUT_MS
    )
    if (gen !== this.generation) return
    const outcome = interpretRegisterResponse(res ? res.status : null, res?.body ?? null)
    switch (outcome.kind) {
      case 'ok':
        this.registered = true
        this.retryAttempt = 0
        this.unreachableTries = 0
        this.set({ state: 'online', text: TEXTS.online })
        this.schedule(() => void this.register(gen), HEARTBEAT_MS)
        return
      case 'taken':
        // Die ID ist vergeben: einmal mit frischer Identität neu versuchen.
        if (!this.renewed) {
          this.renewed = true
          try {
            this.deps.renewIdentity()
          } catch {
            this.set({ state: 'error', text: TEXTS.taken })
            return
          }
          // Neue Geräte-ID heißt: Selbsttest erneut (health liefert jetzt die neue).
          void this.selfTestThenRegister(gen)
          return
        }
        this.registered = false
        this.set({ state: 'error', text: TEXTS.taken })
        return
      case 'blocked':
        this.registered = false
        this.set({ state: 'blocked', text: TEXTS.blocked })
        return
      case 'unreachable':
        this.unreachableTries++
        if (this.unreachableTries < UNREACHABLE_MAX_TRIES) {
          this.set({
            state: 'connecting',
            text: TEXTS.unreachable,
            retryAt: this.now() + UNREACHABLE_RETRY_MS
          })
          this.schedule(() => void this.register(gen), UNREACHABLE_RETRY_MS)
          return
        }
        // Nach fünf Versuchen auf den langsamen Takt wechseln, von vorn zählen.
        this.unreachableTries = 0
        this.retryLater(gen, TEXTS.unreachable)
        return
      case 'retry':
        this.retryLater(gen, TEXTS.offline)
        return
      case 'invalid':
        this.registered = false
        this.set({ state: 'error', text: TEXTS.invalid })
        return
    }
  }

  private retryLater(gen: number, text: string): void {
    const wait = retryDelay(this.retryAttempt++)
    // Eine bestehende Anmeldung bleibt beim Relay bestehen; die Links können
    // trotzdem gehen. Ehrlich bleiben: wir wissen es gerade nicht.
    this.set({ state: 'offline', text, retryAt: this.now() + wait })
    this.schedule(() => void this.selfTestThenRegister(gen), wait)
  }

  private post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
    return this.request(
      this.deps.baseUrl.replace(/\/+$/, '') + path,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      timeoutMs
    )
  }

  /** Anfrage mit hartem Timeout; null bei Netzfehler/Timeout. Wirft nie. */
  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    timeoutMs: number
  ): Promise<{ status: number; body: unknown } | null> {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    ;(t as { unref?: () => void }).unref?.()
    try {
      const res = await this.deps.fetch(url, { ...init, signal: controller.signal })
      const body = await res.json().catch(() => null)
      return { status: res.status, body }
    } catch {
      return null
    } finally {
      clearTimeout(t)
    }
  }
}
