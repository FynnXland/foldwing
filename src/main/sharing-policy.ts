import { APP_NAME } from './brand'
/**
 * Teilen nach Bedarf – reine, elektronfreie Entscheidungslogik (getestet in
 * tests/sharing-policy.test.ts).
 *
 * Server und Tunnel laufen genau dann, wenn es etwas zu teilen gibt: eine noch
 * gültige Freigabe, einen laufenden Upload oder ein kurzes „Festhalten" (z. B.
 * während jemand die Verbindung testet oder die Betriebsart wechselt). Fällt der
 * letzte Grund weg, läuft erst eine Schonfrist ab – wer eine Freigabe löscht und
 * gleich die nächste anlegt, soll keinen Stopp mit Neustart auslösen.
 */

/** Schonfrist zwischen „nichts mehr zu teilen" und dem Stoppen. */
export const IDLE_GRACE_MS = 60_000

/** So lange bleibt das Teilen nach Wechsel der Betriebsart oder einem Verbindungstest an. */
export const HOLD_MS = 2 * 60_000

export type SharingReason = 'shares' | 'upload' | 'hold'

export interface SharingInput {
  now: number
  /** Ablaufzeitpunkte aller vorhandenen Freigaben; fehlend/0 = permanent. */
  shareExpiries: readonly (number | null | undefined)[]
  /** Läuft gerade ein Upload? */
  uploading: boolean
  /** Bis wann das Teilen festgehalten wird (0 = gar nicht). */
  holdUntil: number
  /** Läuft das Teilen gerade (Server an)? */
  running: boolean
  /** Seit wann es keinen Grund mehr gibt; null, solange es einen gab. */
  idleSince: number | null
  /** Schonfrist, Standard IDLE_GRACE_MS. */
  graceMs?: number
}

export type SharingDecision =
  /** Laufen bzw. starten. `recheckAt`: frühester Moment, an dem ein Grund von selbst wegfällt. */
  | { action: 'run'; reasons: SharingReason[]; idleSince: null; recheckAt: number | null }
  /** Nichts mehr zu teilen, Schonfrist läuft: weiterlaufen und um `recheckAt` neu entscheiden. */
  | { action: 'wait'; reasons: []; idleSince: number; recheckAt: number }
  /** Stoppen bzw. aus bleiben. */
  | { action: 'stop'; reasons: []; idleSince: null; recheckAt: null }

/** Noch gültig? Dieselbe Regel wie isExpired() in store.ts (fehlend/0 = permanent). */
function isActive(expiresAt: number | null | undefined, now: number): boolean {
  return !expiresAt || expiresAt > now
}

/** Anzahl der noch gültigen Freigaben. */
export function countActiveShares(
  expiries: readonly (number | null | undefined)[],
  now: number
): number {
  return expiries.filter((e) => isActive(e, now)).length
}

/** Soll geteilt werden – jetzt, gleich noch oder nicht mehr? */
export function decideSharing(input: SharingInput): SharingDecision {
  const { now } = input
  const grace = Math.max(0, input.graceMs ?? IDLE_GRACE_MS)
  const active = input.shareExpiries.filter((e) => isActive(e, now))
  const held = input.holdUntil > now

  const reasons: SharingReason[] = []
  if (active.length > 0) reasons.push('shares')
  if (input.uploading) reasons.push('upload')
  if (held) reasons.push('hold')

  if (reasons.length > 0) {
    // Ohne äußeres Ereignis kann ein Grund nur wegfallen, wenn eine Freigabe
    // abläuft oder das Festhalten endet – dann neu entscheiden.
    let recheckAt: number | null = held ? input.holdUntil : null
    for (const e of active) {
      if (e && (recheckAt === null || e < recheckAt)) recheckAt = e
    }
    return { action: 'run', reasons, idleSince: null, recheckAt }
  }

  if (!input.running) return { action: 'stop', reasons: [], idleSince: null, recheckAt: null }

  // Läuft noch, aber nichts mehr zu teilen: Schonfrist abwarten. Ging die Uhr
  // zurück, zählt die Frist ab jetzt neu – sonst würde ewig gewartet.
  const since = input.idleSince !== null && input.idleSince <= now ? input.idleSince : now
  const until = since + grace
  if (now >= until) return { action: 'stop', reasons: [], idleSince: null, recheckAt: null }
  return { action: 'wait', reasons: [], idleSince: since, recheckAt: until }
}

// ---- Kurzbeschreibung für den Infobereich ----------------------------------

const KEY_LABELS: Record<string, string> = {
  control: 'Strg',
  ctrl: 'Strg',
  commandorcontrol: 'Strg',
  cmdorctrl: 'Strg',
  shift: 'Umschalt',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  printscreen: 'Druck',
  esc: 'Esc',
  escape: 'Esc',
  return: 'Enter',
  enter: 'Enter',
  space: 'Leertaste',
  backspace: 'Rücktaste',
  delete: 'Entf',
  insert: 'Einfg',
  home: 'Pos1',
  end: 'Ende',
  pageup: 'Bild auf',
  pagedown: 'Bild ab',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  menu: 'Menü',
  plus: '+'
}

/** Electron-Accelerator lesbar machen: "Control+Shift+S" -> "Strg+Umschalt+S", "PrintScreen" -> "Druck". */
export function hotkeyLabel(accelerator: string, platform: string): string {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const k = part.toLowerCase()
      if (k === 'super' || k === 'meta' || k === 'cmd' || k === 'command') {
        return platform === 'win32' ? 'Win' : 'Super'
      }
      return KEY_LABELS[k] ?? part
    })
    .join('+')
}

// ---- Zustand der Links -----------------------------------------------------

export type LinkMode = 'relay' | 'lan' | 'domain'

/** Was die Oberfläche über die Erreichbarkeit der Links sagt. */
export type LinkState =
  | 'resting'
  /** Relay: Der Hinweis vor der ersten Anmeldung ist noch nicht bestätigt. */
  | 'waiting'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'blocked'
  | 'error'

export interface LinkStatus {
  mode: LinkMode
  state: LinkState
  /** Kurzer, menschlicher Satz für Kopfzeile, Banner und Einstellungen. */
  text: string
}

export interface LinkStatusInput {
  mode: LinkMode
  /** Server läuft (sonst ruht alles, weil nichts geteilt ist). */
  running: boolean
  tunnel: { status: 'off' | 'starting' | 'connected' | 'error'; detail: string; cloudflaredFound: boolean }
  /** Relay-Anmeldung (nur Modus 'relay'). */
  relay: { state: 'idle' | 'connecting' | 'online' | 'offline' | 'blocked' | 'error'; text: string }
  /** Modus 'domain': Tunnel-Token und Adresse eingetragen? */
  domainReady: boolean
  /** Modus 'lan': gefundene LAN-Adresse. */
  lanAddress: string | null
  /** Modus 'relay': Hinweis vor der ersten Anmeldung bestätigt? */
  relayAccepted: boolean
}

const RESTING = 'Ruht, bis du etwas teilst.'

/** Ein Zustand für alle drei Betriebsarten – rein, damit testbar. */
export function describeLinkStatus(i: LinkStatusInput): LinkStatus {
  const out = (state: LinkState, text: string): LinkStatus => ({ mode: i.mode, state, text })

  if (i.mode === 'domain' && !i.domainReady) {
    return out('error', 'Für die eigene Domain fehlen noch Adresse oder Tunnel-Token.')
  }
  if (!i.running) return out('resting', RESTING)

  if (i.mode === 'relay' && !i.relayAccepted) {
    return out('waiting', 'Wartet auf dich: Bestätige kurz den Hinweis zum Internet-Link.')
  }

  if (i.mode === 'lan') {
    return i.lanAddress
      ? out('online', 'Im eigenen Netzwerk erreichbar.')
      : out('offline', 'Kein Netzwerk gefunden. Die Links gehen gerade nur auf diesem Rechner.')
  }

  if (!i.tunnel.cloudflaredFound && i.tunnel.status === 'error') {
    return out('error', `Ein Programmteil fehlt (cloudflared). Installier ${APP_NAME} neu, dann geht es wieder.`)
  }
  if (i.tunnel.status === 'error') {
    return out('offline', 'Die Verbindung zu Cloudflare ist weg. Ein neuer Versuch läuft.')
  }
  if (i.tunnel.status !== 'connected') return out('connecting', 'Verbinde …')

  if (i.mode === 'domain') return out('online', 'Online über deine Domain.')

  switch (i.relay.state) {
    case 'online':
      return out('online', i.relay.text)
    case 'blocked':
      return out('blocked', i.relay.text)
    case 'error':
      return out('error', i.relay.text)
    case 'offline':
      return out('offline', i.relay.text)
    default:
      return out('connecting', i.relay.text || 'Verbinde …')
  }
}

export interface TrayInput {
  hotkey: string
  hotkeyActive: boolean
  activeShares: number
  /** Zustand der Links (describeLinkStatus). */
  link: LinkState
  platform: string
}

/**
 * Tooltip des Infobereich-Symbols – kurz und nur, was stimmt: den Hotkey nur,
 * wenn er wirklich belegt ist, „online" nur, wenn die Links erreichbar sind.
 */
export function trayTooltip(t: TrayInput): string {
  let text = APP_NAME
  const key = t.hotkeyActive ? hotkeyLabel(t.hotkey, t.platform) : ''
  if (key) text += ` · Screenshot mit ${key}`
  if (t.activeShares > 0) {
    const links = t.activeShares === 1 ? '1 Link' : `${t.activeShares} Links`
    if (t.link === 'online') text += ` · ${links} online`
    else if (t.link === 'connecting') text += ` · ${links}, verbinde …`
    else if (t.link === 'waiting') text += ` · ${links}, wartet auf dich`
    else if (t.link === 'blocked') text += ` · ${links} gesperrt`
    else text += ` · ${links} offline`
  }
  return text
}
