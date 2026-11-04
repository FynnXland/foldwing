import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RelayClient,
  DEFAULT_RELAY_URL,
  HEARTBEAT_MS,
  UNREACHABLE_RETRY_MS,
  UNREACHABLE_MAX_TRIES,
  SECRET_RE,
  DEVICE_ID_RE,
  randomBase62,
  makeDeviceId,
  makeSecret,
  relayBaseUrl,
  relayShareUrl,
  splitToken,
  parseQuickTunnelUrl,
  encodeSecret,
  decodeSecret,
  interpretRegisterResponse,
  retryDelay,
  type RelayIdentity,
  type RelayStatus,
  type SecretCipher
} from '../src/main/relay'

// ---- Kennungen und Links --------------------------------------------------------

test('makeDeviceId/makeSecret: Formate laut SPEC, zufällig', () => {
  const ids = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const d = makeDeviceId()
    assert.match(d, DEVICE_ID_RE)
    ids.add(d)
    const s = makeSecret()
    assert.equal(s.length, 43)
    assert.match(s, SECRET_RE)
  }
  assert.ok(ids.size > 195, 'Geräte-IDs wiederholen sich auffällig oft')
})

test('randomBase62: Bytes ab 248 werden verworfen (kein Modulo-Bias)', () => {
  // Erster Aufruf liefert nur unbrauchbare Bytes, der zweite brauchbare.
  let call = 0
  const rand = (n: number): Buffer => Buffer.alloc(n, call++ === 0 ? 250 : 1)
  assert.equal(randomBase62(4, rand), 'BBBB')
  assert.equal(call, 2)
})

test('relayBaseUrl: Standard share.fynn.land, nur gültige Überschreibung', () => {
  assert.equal(relayBaseUrl({}), DEFAULT_RELAY_URL)
  assert.equal(DEFAULT_RELAY_URL, 'https://share.fynn.land')
  assert.equal(relayBaseUrl({ FOLDWING_RELAY_URL: 'http://127.0.0.1:8011/' }), 'http://127.0.0.1:8011')
  for (const bad of ['ftp://x.example.com', 'kein url', 'https://u:p@example.com', 'https://example.com/?a=1']) {
    assert.equal(relayBaseUrl({ FOLDWING_RELAY_URL: bad }), DEFAULT_RELAY_URL, bad)
  }
})

test('relayShareUrl und splitToken: T = Geräte-ID + Freigabe-ID', () => {
  assert.equal(relayShareUrl('https://share.fynn.land/', 'Ab3dEf7h', 'Q1w2E3r4T5'), 'https://share.fynn.land/Ab3dEf7hQ1w2E3r4T5')
  assert.deepEqual(splitToken('Ab3dEf7hQ1w2E3r4T5'), { deviceId: 'Ab3dEf7h', shareId: 'Q1w2E3r4T5' })
  assert.equal(splitToken('Ab3dEf7hQ1w2E3r4T'), null)
  assert.equal(splitToken('Ab3dEf7hQ1w2E3r4T5x'), null)
  assert.equal(splitToken('Ab3dEf7h-1w2E3r4T5'), null)
})

// ---- Quick-Tunnel-Adresse aus der cloudflared-Ausgabe ------------------------------

test('parseQuickTunnelUrl: liest die Adresse aus der Kasten-Zeile', () => {
  const out = [
    '2026-11-03T22:15:34Z INF Thank you for trying Cloudflare Tunnel. ... (https://www.cloudflare.com/website-terms/) ...',
    '2026-11-03T22:15:34Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '2026-11-03T22:15:39Z INF +--------------------------------------------------------------------------------------------+',
    '2026-11-03T22:15:39Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
    '2026-11-03T22:15:39Z INF |  https://childrens-enjoy-area-pull.trycloudflare.com                                       |'
  ].join('\n')
  assert.equal(parseQuickTunnelUrl(out), 'https://childrens-enjoy-area-pull.trycloudflare.com')
})

test('parseQuickTunnelUrl: ignoriert api.trycloudflare.com, fremde Hosts und Halbes', () => {
  assert.equal(
    parseQuickTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'),
    null
  )
  assert.equal(parseQuickTunnelUrl('Requesting new quick Tunnel on trycloudflare.com...'), null)
  assert.equal(parseQuickTunnelUrl('https://abc.trycloudflare.com.evil.example'), null)
  assert.equal(parseQuickTunnelUrl('https://ABC.trycloudflare.com'), null)
  assert.equal(parseQuickTunnelUrl(''), null)
})

// ---- Geheimnis ablegen ---------------------------------------------------------

/** Spielzeug-Verschlüsselung: Bytes umdrehen – reicht, um den Weg zu prüfen. */
function cipher(available = true): SecretCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (p) => Buffer.from(p, 'utf8').reverse(),
    decryptString: (b) => Buffer.from(b).reverse().toString('utf8')
  }
}

test('encodeSecret/decodeSecret: safeStorage, sonst base64 mit Kennzeichen', () => {
  const secret = makeSecret()
  const safe = encodeSecret(secret, cipher())
  assert.match(safe, /^safe:/)
  assert.ok(!safe.includes(secret), 'Klartext darf nicht in der Ablage stehen')
  assert.equal(decodeSecret(safe, cipher()), secret)

  const plain = encodeSecret(secret, cipher(false))
  assert.match(plain, /^b64:/)
  assert.equal(decodeSecret(plain, null), secret)
  assert.equal(encodeSecret(secret, null).slice(0, 4), 'b64:')

  // Verschlüsselt, aber safeStorage jetzt nicht verfügbar -> nicht lesbar.
  assert.equal(decodeSecret(safe, cipher(false)), null)
  assert.equal(decodeSecret(safe, null), null)
  // Unsinn und falsche Formen -> null statt Ausnahme.
  assert.equal(decodeSecret('', cipher()), null)
  assert.equal(decodeSecret('b64:' + Buffer.from('zu kurz').toString('base64'), null), null)
  assert.equal(decodeSecret('was anderes', cipher()), null)
  const broken: SecretCipher = { ...cipher(), decryptString: () => { throw new Error('kaputt') } }
  assert.equal(decodeSecret(safe, broken), null)
})

// ---- Antworten auswerten -----------------------------------------------------------

test('interpretRegisterResponse: Statuscodes laut SPEC', () => {
  assert.deepEqual(interpretRegisterResponse(200, { ok: true }), { kind: 'ok' })
  assert.deepEqual(interpretRegisterResponse(200, { ok: false }), { kind: 'retry' })
  assert.deepEqual(interpretRegisterResponse(409, { ok: false, error: 'taken' }), { kind: 'taken' })
  assert.deepEqual(interpretRegisterResponse(403, { ok: false, error: 'blocked' }), { kind: 'blocked' })
  assert.deepEqual(interpretRegisterResponse(422, null), { kind: 'unreachable' })
  assert.deepEqual(interpretRegisterResponse(429, null), { kind: 'retry' })
  assert.deepEqual(interpretRegisterResponse(503, 'kein json'), { kind: 'retry' })
  assert.deepEqual(interpretRegisterResponse(null, null), { kind: 'retry' })
  assert.deepEqual(interpretRegisterResponse(400, { ok: false }), { kind: 'invalid', status: 400 })
  assert.deepEqual(interpretRegisterResponse(404, null), { kind: 'invalid', status: 404 })
})

test('retryDelay: 30 s, 2 min, 10 min, danach bleibt es bei 10 min', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(retryDelay), [30_000, 120_000, 600_000, 600_000, 600_000])
})

// ---- Der Client mit gemocktem fetch und eigener Uhr ------------------------------------

const TUNNEL = 'https://alpha-beta-gamma.trycloudflare.com'
const BASE = 'http://relay.test'

interface Call {
  url: string
  method: string
  body: Record<string, unknown> | null
}

/** Uhr und Timer zum Vorspulen. */
function fakeClock(): {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  advance: (ms: number) => Promise<void>
  pending: () => number
} {
  let now = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (t) => void timers.delete(t as number),
    async advance(ms) {
      const end = now + ms
      for (;;) {
        await settle()
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
      await settle()
    },
    pending: () => timers.size
  }
}

/** Alle anstehenden Mikro- und Makroaufgaben abarbeiten (Antworten des Mock-fetch). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

interface Scenario {
  health?: (call: number, deviceId: string) => { status: number; body: unknown } | 'network'
  register?: (call: number, body: Record<string, unknown>) => { status: number; body: unknown } | 'network'
}

function setup(sc: Scenario = {}): {
  client: RelayClient
  clock: ReturnType<typeof fakeClock>
  calls: Call[]
  states: RelayStatus[]
  identity: { current: RelayIdentity; renewed: number }
} {
  const clock = fakeClock()
  const calls: Call[] = []
  const states: RelayStatus[] = []
  const identity = { current: { deviceId: 'Ab3dEf7h', secret: 'S'.repeat(43) }, renewed: 0 }
  let healthCalls = 0
  let registerCalls = 0
  const client = new RelayClient({
    baseUrl: BASE,
    version: '1.4.0',
    identity: () => identity.current,
    renewIdentity: () => {
      identity.renewed++
      identity.current = { deviceId: `Neu${identity.renewed}xxxx`.slice(0, 8), secret: 'T'.repeat(43) }
      return identity.current
    },
    onStatus: (s) => states.push(s),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    fetch: async (url, init) => {
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null
      calls.push({ url, method: init.method, body })
      let r: { status: number; body: unknown } | 'network'
      if (url === `${TUNNEL}/api/health`) {
        r = sc.health
          ? sc.health(healthCalls++, identity.current.deviceId)
          : { status: 200, body: { ok: true, app: 'Foldwing', device: identity.current.deviceId } }
      } else if (url === `${BASE}/_/api/register`) {
        r = sc.register ? sc.register(registerCalls++, body ?? {}) : { status: 200, body: { ok: true } }
      } else if (url === `${BASE}/_/api/unregister`) {
        r = { status: 200, body: { ok: true } }
      } else {
        r = { status: 404, body: null }
      }
      if (r === 'network') throw new Error('Netzfehler')
      const res = r
      return { status: res.status, json: async () => res.body }
    }
  })
  return { client, clock, calls, states, identity }
}

const registers = (calls: Call[]): Call[] => calls.filter((c) => c.url.endsWith('/_/api/register'))

test('RelayClient: Selbsttest, Anmeldung mit id/secret/url/version, dann online', async () => {
  const { client, calls, states } = setup()
  client.connect(TUNNEL)
  await settle()
  assert.equal(client.getStatus().state, 'online')
  assert.equal(client.isRegistered(), true)
  assert.equal(calls[0].url, `${TUNNEL}/api/health`)
  assert.equal(calls[0].method, 'GET')
  const reg = registers(calls)
  assert.equal(reg.length, 1)
  assert.equal(reg[0].method, 'POST')
  assert.deepEqual(reg[0].body, { id: 'Ab3dEf7h', secret: 'S'.repeat(43), url: TUNNEL, version: '1.4.0' })
  assert.ok(JSON.stringify(reg[0].body).length < 2048, 'Anmeldung bleibt unter 2 KB')
  assert.deepEqual(
    states.map((s) => s.state),
    ['connecting', 'connecting', 'online']
  )
})

test('RelayClient: Heartbeat meldet alle 6 Stunden erneut an', async () => {
  const { client, clock, calls } = setup()
  client.connect(TUNNEL)
  await settle()
  assert.equal(registers(calls).length, 1)
  await clock.advance(HEARTBEAT_MS - 1)
  assert.equal(registers(calls).length, 1)
  await clock.advance(1)
  assert.equal(registers(calls).length, 2)
  await clock.advance(HEARTBEAT_MS)
  assert.equal(registers(calls).length, 3)
  assert.equal(client.getStatus().state, 'online')
})

test('RelayClient: wartet, bis der eigene Tunnel mit der eigenen Geräte-ID antwortet', async () => {
  const { client, clock, calls } = setup({
    health: (n, dev) =>
      n === 0
        ? 'network'
        : n === 1
          ? { status: 200, body: { ok: true, app: 'Foldwing', device: 'Fremd123' } }
          : { status: 200, body: { ok: true, app: 'Foldwing', device: dev } }
  })
  client.connect(TUNNEL)
  await settle()
  assert.equal(registers(calls).length, 0, 'ohne bestandenen Selbsttest keine Anmeldung')
  assert.equal(client.getStatus().state, 'connecting')
  await clock.advance(10_000)
  assert.equal(registers(calls).length, 1)
  assert.equal(client.getStatus().state, 'online')
})

test('RelayClient: 409 -> einmal neue Identität und neu anmelden; zweites 409 -> Fehler', async () => {
  const ok = setup({ register: (n) => (n === 0 ? { status: 409, body: { ok: false, error: 'taken' } } : { status: 200, body: { ok: true } }) })
  ok.client.connect(TUNNEL)
  await settle()
  assert.equal(ok.identity.renewed, 1)
  const reg = registers(ok.calls)
  assert.equal(reg.length, 2)
  assert.notEqual(reg[1].body?.id, reg[0].body?.id, 'zweiter Versuch mit neuer Geräte-ID')
  assert.equal(ok.client.getStatus().state, 'online')

  const bad = setup({ register: () => ({ status: 409, body: { ok: false, error: 'taken' } }) })
  bad.client.connect(TUNNEL)
  await settle()
  assert.equal(bad.identity.renewed, 1, 'nur einmal erneuern')
  assert.equal(registers(bad.calls).length, 2)
  assert.equal(bad.client.getStatus().state, 'error')
  assert.equal(bad.clock.pending(), 0, 'kein endloser Neuversuch')
})

test('RelayClient: 403 -> gesperrt, kein Neuversuch', async () => {
  const { client, clock, calls } = setup({ register: () => ({ status: 403, body: { ok: false, error: 'blocked' } }) })
  client.connect(TUNNEL)
  await settle()
  assert.equal(client.getStatus().state, 'blocked')
  assert.match(client.getStatus().text, /gesperrt/)
  assert.equal(clock.pending(), 0)
  await clock.advance(24 * 3_600_000)
  assert.equal(registers(calls).length, 1)
})

test('RelayClient: 422 -> alle 15 s neu, höchstens 5-mal, dann langsamer Takt', async () => {
  const { client, clock, calls } = setup({ register: () => ({ status: 422, body: null }) })
  client.connect(TUNNEL)
  await settle()
  assert.equal(registers(calls).length, 1)
  for (let i = 2; i <= UNREACHABLE_MAX_TRIES; i++) {
    await clock.advance(UNREACHABLE_RETRY_MS)
    assert.equal(registers(calls).length, i, `Versuch ${i}`)
    assert.equal(client.getStatus().state, i < UNREACHABLE_MAX_TRIES ? 'connecting' : 'offline')
  }
  // Nach dem fünften: kein 15-s-Takt mehr, sondern Backoff (30 s).
  await clock.advance(UNREACHABLE_RETRY_MS)
  assert.equal(registers(calls).length, UNREACHABLE_MAX_TRIES)
  await clock.advance(30_000 - UNREACHABLE_RETRY_MS)
  assert.equal(registers(calls).length, UNREACHABLE_MAX_TRIES + 1)
})

test('RelayClient: 5xx, 429 und Netzfehler -> Backoff 30 s, 2 min, 10 min', async () => {
  const answers: (({ status: number; body: unknown }) | 'network')[] = [
    { status: 503, body: null },
    { status: 429, body: null },
    'network',
    { status: 500, body: null },
    { status: 200, body: { ok: true } }
  ]
  const { client, clock, calls } = setup({ register: (n) => answers[n] })
  client.connect(TUNNEL)
  await settle()
  assert.equal(client.getStatus().state, 'offline')
  const expectAfter = async (ms: number, count: number): Promise<void> => {
    await clock.advance(ms - 1)
    assert.equal(registers(calls).length, count - 1, `noch nicht nach ${ms - 1} ms`)
    await clock.advance(1)
    assert.equal(registers(calls).length, count, `nach ${ms} ms`)
  }
  await expectAfter(30_000, 2)
  await expectAfter(120_000, 3)
  await expectAfter(600_000, 4)
  await expectAfter(600_000, 5)
  assert.equal(client.getStatus().state, 'online')
})

test('RelayClient: disconnect meldet ab und hält alle Timer an', async () => {
  const { client, clock, calls } = setup()
  client.connect(TUNNEL)
  await settle()
  await client.disconnect()
  const un = calls.filter((c) => c.url.endsWith('/_/api/unregister'))
  assert.equal(un.length, 1)
  assert.deepEqual(un[0].body, { id: 'Ab3dEf7h', secret: 'S'.repeat(43) })
  assert.equal(client.getStatus().state, 'idle')
  assert.equal(client.isRegistered(), false)
  const before = calls.length
  await clock.advance(HEARTBEAT_MS * 2)
  assert.equal(calls.length, before, 'nach dem Abmelden kein Heartbeat mehr')
})

test('RelayClient: disconnect ohne Anmeldung schickt nichts; mitten im Selbsttest bricht er ab', async () => {
  const { client, clock, calls } = setup({ health: () => 'network' })
  client.connect(TUNNEL)
  await settle()
  await client.disconnect()
  assert.equal(calls.filter((c) => c.url.endsWith('/_/api/unregister')).length, 0)
  const before = calls.length
  await clock.advance(120_000)
  assert.equal(calls.length, before)
})

test('RelayClient: neue Tunnel-Adresse ersetzt die alte, gleiche Adresse tut nichts', async () => {
  const { client, calls } = setup()
  client.connect(TUNNEL)
  await settle()
  client.connect(TUNNEL)
  await settle()
  assert.equal(registers(calls).length, 1)
  const other = 'https://delta-epsilon.trycloudflare.com'
  client.connect(other)
  await settle()
  // Der Mock beantwortet health nur für TUNNEL – für die neue Adresse also erst nach Wechsel nichts.
  assert.equal(client.currentTunnelUrl(), other)
})

test('RelayClient: ungültige Tunnel-Adresse -> Fehler ohne Anfrage', async () => {
  const { client, calls } = setup()
  client.connect('https://example.com')
  await settle()
  assert.equal(client.getStatus().state, 'error')
  assert.equal(calls.length, 0)
})
