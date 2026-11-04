import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideSharing,
  countActiveShares,
  hotkeyLabel,
  trayTooltip,
  describeLinkStatus,
  IDLE_GRACE_MS,
  HOLD_MS,
  type SharingInput,
  type TrayInput,
  type LinkStatusInput
} from '../src/main/sharing-policy'
import { APP_NAME } from '../src/main/brand'
import { isExpired } from '../src/main/store'

const NOW = 1_700_000_000_000

/** Ruhiger Grundzustand: nichts geteilt, nichts läuft. */
function input(over: Partial<SharingInput> = {}): SharingInput {
  return {
    now: NOW,
    shareExpiries: [],
    uploading: false,
    holdUntil: 0,
    running: false,
    idleSince: null,
    ...over
  }
}

// ---- Gründe zu laufen -------------------------------------------------------

test('nichts zu teilen und nichts läuft -> bleibt aus', () => {
  assert.deepEqual(decideSharing(input()), {
    action: 'stop',
    reasons: [],
    idleSince: null,
    recheckAt: null
  })
})

test('permanente Freigabe -> läuft, kein Zeitpunkt zum Nachsehen', () => {
  for (const e of [undefined, null, 0]) {
    const d = decideSharing(input({ shareExpiries: [e] }))
    assert.equal(d.action, 'run')
    assert.deepEqual(d.reasons, ['shares'])
    assert.equal(d.recheckAt, null)
  }
})

test('Freigabe mit Ablauf -> läuft bis dahin, dann neu entscheiden', () => {
  const d = decideSharing(input({ shareExpiries: [NOW + 5_000, NOW + 2_000, undefined] }))
  assert.equal(d.action, 'run')
  assert.equal(d.recheckAt, NOW + 2_000, 'der früheste Ablauf zählt')
})

test('nur abgelaufene Freigaben zählen nicht – genau „jetzt" gilt als abgelaufen', () => {
  for (const e of [NOW - 1, NOW, -5]) {
    assert.equal(decideSharing(input({ shareExpiries: [e] })).action, 'stop', `expiresAt=${e}`)
  }
  assert.equal(decideSharing(input({ shareExpiries: [NOW + 1] })).action, 'run')
})

test('Ablauf-Regel stimmt mit isExpired() aus store.ts überein', () => {
  const now = Date.now()
  for (const e of [undefined, 0, now - 60_000, now + 60_000]) {
    const active = countActiveShares([e], now) === 1
    assert.equal(active, !isExpired({ id: 'x', name: 'x', mime: 'x', size: 0, createdAt: 0, expiresAt: e }))
  }
})

test('laufender Upload -> läuft', () => {
  const d = decideSharing(input({ uploading: true }))
  assert.equal(d.action, 'run')
  assert.deepEqual(d.reasons, ['upload'])
  assert.equal(d.recheckAt, null)
})

test('Festhalten -> läuft bis zum Ende des Festhaltens, „jetzt" ist schon vorbei', () => {
  const held = decideSharing(input({ holdUntil: NOW + HOLD_MS }))
  assert.equal(held.action, 'run')
  assert.deepEqual(held.reasons, ['hold'])
  assert.equal(held.recheckAt, NOW + HOLD_MS)

  assert.equal(decideSharing(input({ holdUntil: NOW })).action, 'stop')
  assert.equal(decideSharing(input({ holdUntil: NOW - 1 })).action, 'stop')
})

test('mehrere Gründe: alle genannt, nachgesehen wird beim frühesten Wegfall', () => {
  const d = decideSharing(
    input({
      shareExpiries: [NOW + 90_000],
      uploading: true,
      holdUntil: NOW + 30_000
    })
  )
  assert.equal(d.action, 'run')
  assert.deepEqual(d.reasons, ['shares', 'upload', 'hold'])
  assert.equal(d.recheckAt, NOW + 30_000)
})

test('ein Grund reicht – auch wenn die Schonfrist längst abgelaufen wäre', () => {
  const d = decideSharing(input({ uploading: true, running: true, idleSince: NOW - 10 * IDLE_GRACE_MS }))
  assert.equal(d.action, 'run')
  assert.equal(d.idleSince, null, 'Schonfrist ist damit vergessen')
})

// ---- Schonfrist ---------------------------------------------------------------

test('Standard-Schonfrist ist eine Minute', () => {
  assert.equal(IDLE_GRACE_MS, 60_000)
  const d = decideSharing(input({ running: true }))
  assert.equal(d.action, 'wait')
  assert.equal(d.recheckAt, NOW + 60_000)
})

test('läuft, Grund fällt weg -> Schonfrist beginnt jetzt', () => {
  const d = decideSharing(input({ running: true, graceMs: 5_000 }))
  assert.deepEqual(d, { action: 'wait', reasons: [], idleSince: NOW, recheckAt: NOW + 5_000 })
})

test('mitten in der Schonfrist -> weiter warten, Beginn bleibt stehen', () => {
  const d = decideSharing(input({ running: true, idleSince: NOW - 2_000, graceMs: 5_000 }))
  assert.deepEqual(d, { action: 'wait', reasons: [], idleSince: NOW - 2_000, recheckAt: NOW + 3_000 })
})

test('Schonfrist genau um -> stoppen', () => {
  const d = decideSharing(input({ running: true, idleSince: NOW - 5_000, graceMs: 5_000 }))
  assert.deepEqual(d, { action: 'stop', reasons: [], idleSince: null, recheckAt: null })
  // Eine Millisekunde vorher wird noch gewartet.
  assert.equal(
    decideSharing(input({ running: true, idleSince: NOW - 4_999, graceMs: 5_000 })).action,
    'wait'
  )
})

test('Schonfrist 0 -> sofort stoppen; negative Frist zählt wie 0', () => {
  assert.equal(decideSharing(input({ running: true, graceMs: 0 })).action, 'stop')
  assert.equal(decideSharing(input({ running: true, graceMs: -100 })).action, 'stop')
})

test('schon gestoppt -> Schonfrist spielt keine Rolle mehr', () => {
  const d = decideSharing(input({ running: false, idleSince: NOW - 1_000 }))
  assert.deepEqual(d, { action: 'stop', reasons: [], idleSince: null, recheckAt: null })
})

test('Uhr zurückgestellt (Beginn in der Zukunft) -> Frist zählt ab jetzt', () => {
  const d = decideSharing(input({ running: true, idleSince: NOW + 3_600_000, graceMs: 5_000 }))
  assert.deepEqual(d, { action: 'wait', reasons: [], idleSince: NOW, recheckAt: NOW + 5_000 })
})

// ---- Ablauf als Ganzes ---------------------------------------------------------

test('Verlauf: löschen, neu teilen in der Schonfrist (kein Flattern), Festhalten, Stopp', () => {
  const grace = 60_000
  let running = false
  let idleSince: number | null = null
  const step = (now: number, over: Partial<SharingInput>): string => {
    const d = decideSharing(input({ now, running, idleSince, graceMs: grace, ...over }))
    idleSince = d.idleSince
    if (d.action === 'run') running = true
    if (d.action === 'stop') running = false
    return d.action
  }

  // Start ohne Freigaben: aus.
  assert.equal(step(NOW, {}), 'stop')
  // Upload beginnt -> sofort an; danach liegt die Freigabe vor.
  assert.equal(step(NOW + 1_000, { uploading: true }), 'run')
  assert.equal(step(NOW + 2_000, { shareExpiries: [undefined] }), 'run')
  // Letzte Freigabe gelöscht -> Schonfrist statt Stopp.
  assert.equal(step(NOW + 10_000, {}), 'wait')
  assert.equal(running, true)
  // 30 s später kommt die nächste Datei: weiterlaufen, kein Neustart nötig.
  assert.equal(step(NOW + 40_000, { uploading: true }), 'run')
  assert.equal(idleSince, null)
  // Wieder gelöscht: die Frist beginnt NEU, nicht ab dem ersten Löschen.
  assert.equal(step(NOW + 50_000, {}), 'wait')
  assert.equal(idleSince, NOW + 50_000)
  assert.equal(step(NOW + 50_000 + grace - 1, {}), 'wait')
  assert.equal(step(NOW + 50_000 + grace, {}), 'stop')
  assert.equal(running, false)
  // Tunnel-Test im Ruhezustand: festhalten -> an, nach dem Festhalten + Frist aus.
  const t = NOW + 200_000
  const hold = { holdUntil: t + HOLD_MS }
  assert.equal(step(t, hold), 'run')
  assert.equal(step(t + HOLD_MS - 1, hold), 'run')
  assert.equal(step(t + HOLD_MS, hold), 'wait')
  assert.equal(step(t + HOLD_MS + grace, hold), 'stop')
})

test('countActiveShares zählt nur Gültiges', () => {
  assert.equal(countActiveShares([], NOW), 0)
  assert.equal(countActiveShares([undefined, 0, null, NOW + 1, NOW, NOW - 1], NOW), 4)
})

// ---- Infobereich ----------------------------------------------------------------

test('hotkeyLabel: Electron-Kürzel auf Deutsch', () => {
  assert.equal(hotkeyLabel('PrintScreen', 'win32'), 'Druck')
  assert.equal(hotkeyLabel('Control+Shift+S', 'win32'), 'Strg+Umschalt+S')
  assert.equal(hotkeyLabel('CommandOrControl+Alt+F5', 'linux'), 'Strg+Alt+F5')
  assert.equal(hotkeyLabel('Super+Shift+PrintScreen', 'win32'), 'Win+Umschalt+Druck')
  assert.equal(hotkeyLabel('Super+Shift+PrintScreen', 'linux'), 'Super+Umschalt+Druck')
  assert.equal(hotkeyLabel('Control+Esc', 'win32'), 'Strg+Esc')
  assert.equal(hotkeyLabel('', 'win32'), '')
})

function tray(over: Partial<TrayInput> = {}): TrayInput {
  return {
    hotkey: 'PrintScreen',
    hotkeyActive: true,
    activeShares: 0,
    link: 'resting',
    platform: 'win32',
    ...over
  }
}

test('trayTooltip: ruhig ohne Freigaben, mit echtem Hotkey', () => {
  assert.equal(trayTooltip(tray()), `${APP_NAME} · Screenshot mit Druck`)
  assert.equal(
    trayTooltip(tray({ hotkey: 'Control+Shift+S' })),
    `${APP_NAME} · Screenshot mit Strg+Umschalt+S`
  )
})

test('trayTooltip: Hotkey nicht belegt -> nicht erwähnt', () => {
  assert.equal(trayTooltip(tray({ hotkeyActive: false })), APP_NAME)
})

test('trayTooltip: „online" nur, wenn die Links auch erreichbar sind', () => {
  const p = `${APP_NAME} · Screenshot mit Druck · `
  assert.equal(trayTooltip(tray({ activeShares: 3, link: 'online' })), p + '3 Links online')
  assert.equal(trayTooltip(tray({ activeShares: 3, link: 'connecting' })), p + '3 Links, verbinde …')
  assert.equal(trayTooltip(tray({ activeShares: 3, link: 'waiting' })), p + '3 Links, wartet auf dich')
  assert.equal(trayTooltip(tray({ activeShares: 3, link: 'offline' })), p + '3 Links offline')
  assert.equal(trayTooltip(tray({ activeShares: 3, link: 'error' })), p + '3 Links offline')
  assert.equal(trayTooltip(tray({ activeShares: 2, link: 'blocked' })), p + '2 Links gesperrt')
  assert.equal(trayTooltip(tray({ activeShares: 1, link: 'resting' })), p + '1 Link offline')
  assert.equal(trayTooltip(tray({ activeShares: 1, link: 'online' })), p + '1 Link online')
})

// ---- Zustand der Links ------------------------------------------------------------

function linkInput(over: Partial<LinkStatusInput> = {}): LinkStatusInput {
  return {
    mode: 'relay',
    running: true,
    tunnel: { status: 'connected', detail: '', cloudflaredFound: true },
    relay: { state: 'online', text: 'Online. Deine Links funktionieren.' },
    domainReady: false,
    lanAddress: '192.168.0.20',
    relayAccepted: true,
    ...over
  }
}

test('describeLinkStatus: nichts geteilt -> ruht, in jeder Betriebsart', () => {
  for (const mode of ['relay', 'lan'] as const) {
    assert.equal(describeLinkStatus(linkInput({ mode, running: false })).state, 'resting')
  }
  assert.equal(
    describeLinkStatus(linkInput({ mode: 'domain', domainReady: true, running: false })).state,
    'resting'
  )
})

test('describeLinkStatus: Relay wartet ohne Bestätigung des Hinweises', () => {
  const s = describeLinkStatus(linkInput({ relayAccepted: false, tunnel: { status: 'off', detail: '', cloudflaredFound: true } }))
  assert.equal(s.state, 'waiting')
  assert.match(s.text, /Wartet auf dich/)
  // Ruht es (nichts geteilt), muss niemand etwas bestätigen.
  assert.equal(describeLinkStatus(linkInput({ relayAccepted: false, running: false })).state, 'resting')
})

test('describeLinkStatus: Relay folgt Tunnel und Anmeldung', () => {
  const t = (status: 'off' | 'starting' | 'connected' | 'error') => ({ status, detail: '', cloudflaredFound: true })
  assert.equal(describeLinkStatus(linkInput({ tunnel: t('starting') })).state, 'connecting')
  assert.equal(describeLinkStatus(linkInput({ tunnel: t('off') })).state, 'connecting')
  assert.equal(describeLinkStatus(linkInput({ tunnel: t('error') })).state, 'offline')
  assert.equal(describeLinkStatus(linkInput()).state, 'online')
  for (const state of ['offline', 'blocked', 'error'] as const) {
    const s = describeLinkStatus(linkInput({ relay: { state, text: 'X' } }))
    assert.deepEqual([s.state, s.text], [state, 'X'])
  }
  assert.equal(describeLinkStatus(linkInput({ relay: { state: 'connecting', text: 'Y' } })).state, 'connecting')
  const missing = describeLinkStatus(
    linkInput({ tunnel: { status: 'error', detail: '', cloudflaredFound: false } })
  )
  assert.equal(missing.state, 'error')
  assert.match(missing.text, /fehlt \(cloudflared\)/)
})

test('describeLinkStatus: eigenes Netz und eigene Domain', () => {
  assert.equal(describeLinkStatus(linkInput({ mode: 'lan' })).state, 'online')
  assert.equal(describeLinkStatus(linkInput({ mode: 'lan', lanAddress: null })).state, 'offline')
  const incomplete = describeLinkStatus(linkInput({ mode: 'domain', domainReady: false }))
  assert.equal(incomplete.state, 'error')
  assert.match(incomplete.text, /Tunnel-Token/)
  assert.equal(describeLinkStatus(linkInput({ mode: 'domain', domainReady: true })).state, 'online')
  assert.equal(
    describeLinkStatus(
      linkInput({ mode: 'domain', domainReady: true, tunnel: { status: 'error', detail: '', cloudflaredFound: true } })
    ).state,
    'offline'
  )
})
