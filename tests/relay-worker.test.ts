// Tests für den Relay-Worker (worker/relay). Speicher: ein Fake-Store und – für
// die echten SQL-Abfragen – D1Store gegen node:sqlite mit schema.sql. Tunnel-
// Aufrufe gehen an ein gemocktes fetch; nichts verlässt den Rechner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createWorker, D1Store, type Store, type Lookup, type DeviceRecord } from '../worker/relay/src/index'
import { parseRelayPath, tokenFromInput, isTunnelUrl } from '../worker/relay/src/ids'
import { normalizeType, isSafeInline, filenameParam } from '../worker/relay/src/proxy'
import { sha256hex, constantTimeEqual } from '../worker/relay/src/security'
// @ts-ignore – reines JS-Modul ohne Typen
import { parseTarget, categoryText, buildSql } from '../worker/scripts/moderate.mjs'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

// ---- Hilfen ------------------------------------------------------------------

const D = 'Dev1ce42'
const S = 'Share12345'
const T = D + S
const F = 'Fil3ab'
const SECRET = 'A'.repeat(43)
const TUNNEL = 'https://brave-blue-otter-one.trycloudflare.com'
const BASE = 'https://share.example.com'

interface FakeDevice {
  secretHash: string
  url: string | null
  online: boolean
  blocked: boolean
  seenAt: number
  blockReason?: string
  blockedAt?: number
}

class FakeStore implements Store {
  devices = new Map<string, FakeDevice>()
  blockedLinks = new Map<string, { reason: string | null; at: number }>()
  lookups = 0

  async lookup(deviceId: string, token: string): Promise<Lookup> {
    this.lookups++
    const d = this.devices.get(deviceId)
    const link = this.blockedLinks.get(token)
    return {
      device: d ? { url: d.url, online: d.online, blocked: d.blocked } : null,
      linkBlocked: !!link,
      block: link ? link : d?.blocked ? { reason: d.blockReason ?? null, at: d.blockedAt ?? null } : null
    }
  }
  async getDevice(id: string): Promise<DeviceRecord | null> {
    const d = this.devices.get(id)
    return d ? { id, secretHash: d.secretHash, url: d.url, online: d.online, blocked: d.blocked } : null
  }
  async upsertDevice(id: string, secretHash: string, url: string, now: number): Promise<boolean> {
    const d = this.devices.get(id)
    if (!d) {
      this.devices.set(id, { secretHash, url, online: true, blocked: false, seenAt: now })
      return true
    }
    if (d.secretHash !== secretHash || d.blocked) return false
    Object.assign(d, { url, online: true, seenAt: now })
    return true
  }
  async setOffline(id: string, secretHash: string): Promise<void> {
    const d = this.devices.get(id)
    if (d && d.secretHash === secretHash) d.online = false
  }
  async deleteStale(cutoff: number): Promise<number> {
    let n = 0
    for (const [id, d] of this.devices) {
      if (d.seenAt < cutoff && !d.blocked) {
        this.devices.delete(id)
        n++
      }
    }
    return n
  }
}

type Call = { url: string; init: RequestInit & { headers?: HeadersInit } }
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function setup(handler: Handler = () => new Response('nope', { status: 500 }), envExtra: Record<string, string> = {}) {
  const store = new FakeStore()
  const calls: Call[] = []
  let clock = 1_000_000
  const worker = createWorker({
    store: () => store,
    fetch: async (url, init = {}) => {
      calls.push({ url, init })
      return handler(url, init)
    },
    now: () => clock
  })
  const env = {
    DB: null as never,
    CONTACT_EMAIL: 'abuse@example.com',
    IMPRINT_URL: 'https://example.com/impressum',
    PRIVACY_URL: 'https://example.com/datenschutz',
    TERMS_URL: 'https://example.com/regeln',
    ...envExtra
  }
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(BASE + path, init), env)
  return {
    store,
    calls,
    worker,
    env,
    call,
    tick: (ms: number) => (clock += ms),
    now: () => clock
  }
}

function healthOk(id = D): Response {
  return new Response(JSON.stringify({ ok: true, app: 'Foldwing', device: id }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

const register = (call: (p: string, i?: RequestInit) => Promise<Response>, body: unknown) =>
  call('/_/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })

async function online(store: FakeStore, url = TUNNEL) {
  store.devices.set(D, { secretHash: await sha256hex(SECRET), url, online: true, blocked: false, seenAt: 1 })
}

function headersOf(call: Call): Headers {
  return new Headers(call.init.headers)
}

// ---- Formate -----------------------------------------------------------------

test('relay: Pfade werden streng erkannt', () => {
  assert.deepEqual(parseRelayPath(`/${T}`), { kind: 'page', token: T, device: D, path: `/${T}` })
  assert.equal(parseRelayPath(`/${T}/${F}`)?.kind, 'page')
  assert.equal(parseRelayPath(`/${T}/d`)?.kind, 'raw')
  assert.equal(parseRelayPath(`/${T}/${F}/d`)?.kind, 'raw')
  assert.equal(parseRelayPath(`/${T}/_font/Geist-Variable.woff2`)?.kind, 'font')
  assert.equal(parseRelayPath(`/${T}/_font/GeistMono-Variable.woff2`)?.kind, 'font')
  for (const bad of [
    `/${T}/`,
    `/${T}x`,
    `/${T.slice(1)}`,
    `/${T}/${F}x`,
    `/${T}/D`,
    `/${T}/_font/evil.woff2`,
    `/${T}/%2e%2e/d`,
    `/${T}//d`,
    `/${T}/s/${S}`,
    `/s/${S}`,
    `/${T}/${F}/d/x`
  ]) {
    assert.equal(parseRelayPath(bad), null, bad)
  }
})

test('relay: nur Quick-Tunnel-Adressen sind gültig', () => {
  assert.ok(isTunnelUrl(TUNNEL))
  for (const bad of [
    'http://a.trycloudflare.com',
    'https://a.trycloudflare.com/',
    'https://a.trycloudflare.com:443',
    'https://a.b.trycloudflare.com',
    'https://A.trycloudflare.com',
    'https://-a.trycloudflare.com',
    'https://a.trycloudflare.com.evil.com',
    'https://evil.com#.trycloudflare.com',
    'https://user@a.trycloudflare.com',
    'https://trycloudflare.com',
    'https://127.0.0.1',
    'https://' + 'a'.repeat(64) + '.trycloudflare.com'
  ]) {
    assert.equal(isTunnelUrl(bad), false, bad)
  }
})

test('relay: Token aus Melde-Eingabe', () => {
  assert.equal(tokenFromInput(T), T)
  assert.equal(tokenFromInput(`${BASE}/${T}/${F}/d?dl=1`), T)
  assert.equal(tokenFromInput(`/${T}`), T)
  assert.equal(tokenFromInput('<script>'), null)
  assert.equal(tokenFromInput(`${T}"><b>`), null)
  assert.equal(tokenFromInput(null), null)
})

test('relay: zeitkonstanter Vergleich und Hash', async () => {
  const h = await sha256hex('abc')
  assert.equal(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.ok(constantTimeEqual(h, h))
  assert.ok(!constantTimeEqual(h, h.slice(0, -1) + '0'))
  assert.ok(!constantTimeEqual(h, h.slice(0, 10)))
})

// ---- Registrierung -----------------------------------------------------------

test('register: neues Gerät wird angelegt, Health-Check geht an den Tunnel', async () => {
  const t = setup(() => healthOk())
  const res = await register(t.call, { id: D, secret: SECRET, url: TUNNEL, version: '1.4.0' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null)
  assert.equal(t.calls.length, 1)
  assert.equal(t.calls[0].url, TUNNEL + '/api/health')
  assert.equal(t.calls[0].init.redirect, 'manual')
  const dev = t.store.devices.get(D)!
  assert.equal(dev.url, TUNNEL)
  assert.equal(dev.online, true)
  assert.equal(dev.secretHash, await sha256hex(SECRET))
  assert.notEqual(dev.secretHash, SECRET)
})

test('register: Update mit gleichem Secret setzt neue Adresse und online', async () => {
  const t = setup(() => healthOk())
  await online(t.store, 'https://old-tunnel.trycloudflare.com')
  t.store.devices.get(D)!.online = false
  t.tick(5000)
  const res = await register(t.call, { id: D, secret: SECRET, url: TUNNEL, version: '1.4.0' })
  assert.equal(res.status, 200)
  const dev = t.store.devices.get(D)!
  assert.equal(dev.url, TUNNEL)
  assert.equal(dev.online, true)
  assert.equal(dev.seenAt, t.now())
})

test('register: falsches Secret → 409 taken, ohne Health-Check', async () => {
  const t = setup(() => healthOk())
  await online(t.store, 'https://old-tunnel.trycloudflare.com')
  const res = await register(t.call, { id: D, secret: 'B'.repeat(43), url: TUNNEL })
  assert.equal(res.status, 409)
  assert.deepEqual(await res.json(), { ok: false, error: 'taken' })
  assert.equal(t.calls.length, 0)
  assert.equal(t.store.devices.get(D)!.url, 'https://old-tunnel.trycloudflare.com')
})

test('register: gesperrtes Gerät → 403 blocked', async () => {
  const t = setup(() => healthOk())
  await online(t.store)
  t.store.devices.get(D)!.blocked = true
  const res = await register(t.call, { id: D, secret: SECRET, url: TUNNEL })
  assert.equal(res.status, 403)
  assert.deepEqual(await res.json(), { ok: false, error: 'blocked' })
})

test('register: falsche Formate → 400', async () => {
  const t = setup(() => healthOk())
  const bad = [
    { id: D, secret: SECRET, url: 'https://evil.com' },
    { id: D, secret: SECRET, url: 'http://a.trycloudflare.com' },
    { id: D, secret: SECRET, url: TUNNEL + '/x' },
    { id: D, secret: SECRET, url: 'https://a.trycloudflare.com@evil.com' },
    { id: D, secret: SECRET },
    { id: 'short', secret: SECRET, url: TUNNEL },
    { id: D + 'x', secret: SECRET, url: TUNNEL },
    { id: D, secret: 'short', url: TUNNEL },
    { id: D, secret: SECRET + '=', url: TUNNEL },
    { id: D, secret: SECRET, url: TUNNEL, version: '<script>' },
    { id: 12345678, secret: SECRET, url: TUNNEL },
    [D, SECRET, TUNNEL],
    'kein json',
    'null'
  ]
  for (const body of bad) {
    const res = await register(t.call, body)
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  assert.equal(t.calls.length, 0)
  assert.equal(t.store.devices.size, 0)
})

test('register: Körper über 2 KB → 413', async () => {
  const t = setup(() => healthOk())
  const res = await register(t.call, { id: D, secret: SECRET, url: TUNNEL, pad: 'x'.repeat(3000) })
  assert.equal(res.status, 413)
  assert.equal(t.store.devices.size, 0)
})

test('register: Health-Check falsch → 422', async () => {
  const cases: Handler[] = [
    () => healthOk('OtherDev'),
    () => new Response(JSON.stringify({ ok: true, app: 'Nope', device: D })),
    () => new Response('kaputt'),
    () => new Response('', { status: 404 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://evil.com/api/health' } }),
    () => new Response(JSON.stringify({ app: 'Foldwing', device: D, pad: 'x'.repeat(2000) })),
    () => {
      throw new TypeError('Netzfehler')
    }
  ]
  for (const handler of cases) {
    const t = setup(handler)
    const res = await register(t.call, { id: D, secret: SECRET, url: TUNNEL })
    assert.equal(res.status, 422)
    assert.deepEqual(await res.json(), { ok: false, error: 'unreachable' })
    assert.equal(t.store.devices.size, 0)
  }
})

test('register: Ratenbegrenzung → 429, ohne Binding läuft es', async () => {
  const t = setup(() => healthOk())
  const limited = { ...t.env, REGISTER_LIMITER: { limit: async () => ({ success: false }) } }
  const req = () =>
    new Request(BASE + '/_/api/register', {
      method: 'POST',
      body: JSON.stringify({ id: D, secret: SECRET, url: TUNNEL })
    })
  assert.equal((await t.worker.fetch(req(), limited)).status, 429)
  const broken = { ...t.env, REGISTER_LIMITER: { limit: async () => Promise.reject(new Error('x')) } }
  assert.equal((await t.worker.fetch(req(), broken)).status, 200)
})

test('register: Rate-Limit-Schlüssel enthalten keine IP im Klartext', async () => {
  const t = setup(() => healthOk())
  const keys: string[] = []
  const env = { ...t.env, REGISTER_LIMITER: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) } }
  await t.worker.fetch(
    new Request(BASE + '/_/api/register', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
      body: JSON.stringify({ id: D, secret: SECRET, url: TUNNEL })
    }),
    env
  )
  assert.equal(keys.length, 2)
  assert.ok(keys.every((k) => !k.includes('203.0.113')))
})

test('register: nur POST', async () => {
  const t = setup()
  const res = await t.call('/_/api/register')
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('Allow'), 'POST')
})

test('unregister: setzt offline, unbekannt → 200, falsches Secret → 409', async () => {
  const t = setup()
  const unreg = (body: unknown) =>
    t.call('/_/api/unregister', { method: 'POST', body: JSON.stringify(body) })
  assert.equal((await unreg({ id: D, secret: SECRET })).status, 200)
  await online(t.store)
  assert.equal((await unreg({ id: D, secret: 'C'.repeat(43) })).status, 409)
  assert.equal(t.store.devices.get(D)!.online, true)
  assert.equal((await unreg({ id: D, secret: SECRET })).status, 200)
  assert.equal(t.store.devices.get(D)!.online, false)
  assert.equal((await unreg({ id: 'x', secret: SECRET })).status, 400)
})

// ---- Rohdaten: Weiterleitung statt Durchreichen ------------------------------

test('raw: /<T>/d und /<T>/<F>/d → 302 auf denselben Pfad beim Tunnel, ohne Tunnel-Aufruf', async () => {
  const t = setup(() => new Response('darf nie kommen'))
  await online(t.store)
  for (const [p, loc] of [
    [`/${T}/d`, `${TUNNEL}/${T}/d`],
    [`/${T}/d?dl=1`, `${TUNNEL}/${T}/d?dl=1`],
    [`/${T}/${F}/d`, `${TUNNEL}/${T}/${F}/d`],
    [`/${T}/${F}/d?dl=1`, `${TUNNEL}/${T}/${F}/d?dl=1`]
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await t.call(p, { method, headers: { Range: 'bytes=0-99' } })
      assert.equal(res.status, 302, p)
      assert.equal(res.headers.get('Location'), loc)
      assert.equal(res.headers.get('Cache-Control'), 'no-store')
      assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer')
      assert.equal(res.headers.get('X-Robots-Tag'), 'noindex, nofollow')
      assert.equal(res.body, null)
    }
  }
  assert.equal(t.calls.length, 0, 'Dateiinhalte fließen nie durch den Worker')
})

test('raw: offline → 503, gesperrt → 451, falsche Adresse in der Datenbank → 503', async () => {
  const t = setup()
  assert.equal((await t.call(`/${T}/d`)).status, 503)
  await online(t.store)
  t.store.devices.get(D)!.online = false
  assert.equal((await t.call(`/${T}/${F}/d`)).status, 503)

  const t2 = setup()
  await online(t2.store)
  t2.store.blockedLinks.set(T, { reason: 'Schadsoftware', at: Date.UTC(2026, 10, 3, 12) })
  const blocked = await t2.call(`/${T}/d?dl=1`)
  assert.equal(blocked.status, 451)
  assert.equal(blocked.headers.get('Location'), null)

  const t3 = setup()
  await online(t3.store, 'https://evil.example.com')
  const res = await t3.call(`/${T}/d`)
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('Location'), null)
})

// ---- Proxy (Seiten und Schriften) --------------------------------------------

test('proxy: Seiten und Schriften gehen mit Pfad und Query unverändert an den Tunnel', async () => {
  const t = setup(() => new Response('<!doctype html><p>hi</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  await online(t.store)
  for (const p of [`/${T}`, `/${T}?x=1`, `/${T}/${F}`, `/${T}/_font/Geist-Variable.woff2`]) {
    const res = await t.call(p)
    await res.arrayBuffer()
  }
  assert.deepEqual(
    t.calls.map((c) => c.url),
    [`${TUNNEL}/${T}`, `${TUNNEL}/${T}?x=1`, `${TUNNEL}/${T}/${F}`, `${TUNNEL}/${T}/_font/Geist-Variable.woff2`]
  )
  assert.ok(t.calls.every((c) => c.init.redirect === 'manual'))
  assert.ok(t.calls.every((c) => c.init.cache === 'no-store'))
})

test('proxy: Seite bekommt strenge CSP, no-store und Sicherheits-Header', async () => {
  const t = setup(
    () =>
      new Response('<!doctype html><p>Seite</p>', {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "script-src 'unsafe-inline'",
          'Set-Cookie': 'a=b',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=99999',
          Refresh: '0;url=https://evil.com',
          Location: 'https://evil.com',
          'X-Frame-Options': 'ALLOWALL'
        }
      })
  )
  await online(t.store)
  const res = await t.call(`/${T}`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '<!doctype html><p>Seite</p>')
  const csp = res.headers.get('Content-Security-Policy')!
  for (const part of [
    "default-src 'none'",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: https://*.trycloudflare.com",
    "media-src 'self' https://*.trycloudflare.com",
    "frame-src 'self' https://*.trycloudflare.com",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'"
  ]) {
    assert.ok(csp.includes(part), part)
  }
  assert.doesNotMatch(csp, /unsafe-eval|blob:/)
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store')
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer')
  assert.equal(res.headers.get('X-Robots-Tag'), 'noindex, nofollow')
  for (const h of ['Set-Cookie', 'Access-Control-Allow-Origin', 'Refresh', 'Location', 'X-Frame-Options']) {
    assert.equal(res.headers.get(h), null, h)
  }
})

test('proxy: Anfrage-Header nur aus der Allowlist, keine Cookies, keine IP', async () => {
  const t = setup(() => new Response('x', { headers: { 'Content-Type': 'text/html' } }))
  await online(t.store)
  await t.call(`/${T}`, {
    headers: {
      Range: 'bytes=100-199',
      'If-Range': '"abc"',
      'If-None-Match': '"abc"',
      'If-Modified-Since': 'Wed, 21 Oct 2015 07:28:00 GMT',
      Accept: 'text/html',
      'Accept-Language': 'de-DE,de;q=0.9',
      Cookie: 'session=geheim',
      Authorization: 'Bearer x',
      'CF-Connecting-IP': '203.0.113.7',
      'X-Forwarded-For': '203.0.113.7',
      'X-Real-IP': '203.0.113.7',
      Referer: 'https://elsewhere.example.com/',
      'User-Agent': 'Besucher-Browser'
    }
  })
  const h = headersOf(t.calls[0])
  assert.equal(h.get('Range'), 'bytes=100-199')
  assert.equal(h.get('If-Range'), '"abc"')
  assert.equal(h.get('If-None-Match'), '"abc"')
  assert.equal(h.get('If-Modified-Since'), 'Wed, 21 Oct 2015 07:28:00 GMT')
  assert.equal(h.get('Accept'), 'text/html')
  assert.equal(h.get('Accept-Language'), 'de-DE,de;q=0.9')
  assert.equal(h.get('User-Agent'), 'Foldwing-Relay')
  assert.deepEqual([...h.keys()].sort(), [
    'accept',
    'accept-language',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'range',
    'user-agent'
  ])
  assert.equal(t.calls[0].init.body, undefined)
})

test('proxy: ungültiger Range wird nicht weitergereicht', async () => {
  const t = setup(() => new Response('x', { headers: { 'Content-Type': 'text/html' } }))
  await online(t.store)
  await t.call(`/${T}`, { headers: { Range: 'bytes=abc' } })
  await t.call(`/${T}`, { headers: { Range: 'items=0-5' } })
  assert.ok(t.calls.every((c) => headersOf(c).get('Range') === null))
})

test('proxy: 206 läuft gestreamt mit Content-Range durch (Schrift)', async () => {
  let pulled = 0
  const t = setup(() => {
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++
        if (pulled > 3) return ctrl.close()
        ctrl.enqueue(new Uint8Array(1000).fill(pulled))
      }
    })
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': 'font/woff2',
        'Content-Range': 'bytes 1000-3999/100000',
        'Content-Length': '3000',
        'Accept-Ranges': 'bytes',
        ETag: '"v1"',
        'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
      }
    })
  })
  await online(t.store)
  const res = await t.call(`/${T}/_font/Geist-Variable.woff2`, { headers: { Range: 'bytes=1000-3999' } })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('Content-Range'), 'bytes 1000-3999/100000')
  assert.equal(res.headers.get('Content-Length'), '3000')
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes')
  assert.equal(res.headers.get('ETag'), '"v1"')
  assert.equal(res.headers.get('Last-Modified'), 'Wed, 21 Oct 2015 07:28:00 GMT')
  assert.match(res.headers.get('Content-Security-Policy')!, /^sandbox allow-downloads/)
  // Der Körper wurde noch nicht gelesen → der Worker hat nichts gepuffert.
  assert.ok(pulled <= 2, `vorab gelesen: ${pulled}`)
  const body = new Uint8Array(await res.arrayBuffer())
  assert.equal(body.length, 3000)
  assert.equal(body[2999], 3)
})

test('proxy: HEAD geht als HEAD durch, ohne Körper, mit Content-Length', async () => {
  const t = setup((_u, init) => {
    assert.equal(init.method, 'HEAD')
    return new Response(null, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '4321' } })
  })
  await online(t.store)
  const res = await t.call(`/${T}`, { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Content-Length'), '4321')
  assert.equal(res.body, null)
})

test('proxy: Seiten-Pfad mit SVG/XML/unbekannt vom Ursprung wird Download, Sandbox erzwungen', async () => {
  const cases: Array<[string | null, string, string]> = [
    ['image/svg+xml', "inline; filename*=UTF-8''x.svg", "attachment; filename*=UTF-8''x.svg"],
    ['application/xhtml+xml', '', 'attachment'],
    ['text/xml', '', 'attachment'],
    ['application/javascript', '', 'attachment'],
    [null, '', 'attachment'],
    ['kaputt', '', 'attachment']
  ]
  for (const [type, cd, expected] of cases) {
    const headers: Record<string, string> = {}
    if (type) headers['Content-Type'] = type
    if (cd) headers['Content-Disposition'] = cd
    // Uint8Array statt String: sonst setzt fetch selbst text/plain.
    const t = setup(() => new Response(new TextEncoder().encode('<script>alert(1)</script>'), { headers }))
    await online(t.store)
    for (const p of [`/${T}`, `/${T}/${F}`]) {
      const res = await t.call(p)
      assert.equal(res.headers.get('Content-Disposition'), expected, `${type} ${p}`)
      assert.match(res.headers.get('Content-Security-Policy')!, /^sandbox allow-downloads/)
      assert.match(res.headers.get('Content-Security-Policy')!, /default-src 'none'/)
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store')
      assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff')
      await res.arrayBuffer()
    }
  }
})

test('proxy: sichere Typen bleiben inline, PDF ohne Sandbox, Download bleibt Download', async () => {
  const cases: Array<[string, string, string | null, RegExp]> = [
    ['image/png', '', null, /^sandbox/],
    ['image/jpeg', "inline; filename*=UTF-8''Alex's%20Foto.jpg", "inline; filename*=UTF-8''Alex's%20Foto.jpg", /^sandbox/],
    ['video/mp4', '', null, /^sandbox/],
    ['text/plain; charset=utf-8', '', null, /^sandbox/],
    ['application/pdf', "inline; filename*=UTF-8''a.pdf", "inline; filename*=UTF-8''a.pdf", /^frame-ancestors 'self'$/],
    ['image/png', "attachment; filename*=UTF-8''b.png", "attachment; filename*=UTF-8''b.png", /^sandbox/],
    ['image/png', 'inline; filename="x"; foo=bar\'', 'inline', /^sandbox/]
  ]
  for (const [type, cd, expected, csp] of cases) {
    const headers: Record<string, string> = { 'Content-Type': type }
    if (cd) headers['Content-Disposition'] = cd
    const t = setup(() => new Response('daten', { headers }))
    await online(t.store)
    const res = await t.call(`/${T}/${F}`)
    assert.equal(res.headers.get('Content-Disposition'), expected, type + cd)
    assert.match(res.headers.get('Content-Security-Policy')!, csp, type)
    await res.arrayBuffer()
  }
})

test('proxy: Medientyp und Dateiname werden bereinigt', () => {
  assert.deepEqual(normalizeType('text/plain; charset=UTF-8; x=y'), {
    essence: 'text/plain',
    header: 'text/plain; charset=utf-8'
  })
  assert.equal(normalizeType('text/plain; charset="utf-7<x>"').header, 'text/plain')
  assert.equal(normalizeType('image/svg+xml').essence, 'image/svg+xml')
  assert.equal(normalizeType('<b>/x').essence, 'application/octet-stream')
  assert.equal(isSafeInline('image/svg+xml'), false)
  assert.equal(isSafeInline('text/html'), false)
  assert.equal(isSafeInline('video/webm'), true)
  assert.equal(filenameParam("attachment; filename*=UTF-8''a%20b.txt"), "; filename*=UTF-8''a%20b.txt")
  assert.equal(filenameParam('attachment; filename="a.txt"'), '')
  assert.equal(filenameParam("attachment; filename*=UTF-8''a\"b"), '')
})

test('proxy: Schrift bekommt festen Typ und Cache', async () => {
  const t = setup(() => new Response('wOF2', { headers: { 'Content-Type': 'text/html' } }))
  await online(t.store)
  const res = await t.call(`/${T}/_font/GeistMono-Variable.woff2`)
  assert.equal(res.headers.get('Content-Type'), 'font/woff2')
  assert.equal(res.headers.get('Cache-Control'), 'private, max-age=3600')
  assert.equal(res.headers.get('Content-Disposition'), null)
})

test('proxy: 3xx vom Ursprung → 502, 304 bleibt 304', async () => {
  const t = setup(() => new Response(null, { status: 302, headers: { Location: 'https://evil.com' } }))
  await online(t.store)
  const res = await t.call(`/${T}`)
  assert.equal(res.status, 502)
  assert.equal(res.headers.get('Location'), null)
  assert.match(await res.text(), /schiefgelaufen/)

  const t2 = setup(() => new Response(null, { status: 304, headers: { ETag: '"v1"' } }))
  await online(t2.store)
  const res2 = await t2.call(`/${T}`, { headers: { 'If-None-Match': '"v1"' } })
  assert.equal(res2.status, 304)
  assert.equal(res2.headers.get('ETag'), '"v1"')
})

test('proxy: 404 der App geht durch, ohne Cache', async () => {
  const t = setup(() => new Response('<p>weg</p>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  await online(t.store)
  const res = await t.call(`/${T}`)
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
  assert.match(res.headers.get('Content-Security-Policy')!, /script-src 'none'/)
})

test('proxy: offline (unbekannt, abgemeldet, Tunnel weg, Netzfehler) → 503-Seite', async () => {
  const t = setup()
  const unknown = await t.call(`/${T}`)
  assert.equal(unknown.status, 503)
  const text = await unknown.text()
  assert.match(text, /Der Rechner, auf dem diese Datei liegt, ist gerade nicht online\./)
  assert.equal(unknown.headers.get('Retry-After'), '60')
  assert.equal(t.calls.length, 0)

  const t2 = setup()
  await online(t2.store)
  t2.store.devices.get(D)!.online = false
  assert.equal((await t2.call(`/${T}`)).status, 503)
  assert.equal(t2.calls.length, 0)

  for (const handler of [
    () => new Response('error 1033', { status: 530 }),
    () => new Response('bad gateway', { status: 502 }),
    () => {
      throw new TypeError('fetch failed')
    }
  ] as Handler[]) {
    const t3 = setup(handler)
    await online(t3.store)
    assert.equal((await t3.call(`/${T}/${F}`)).status, 503)
  }
})

test('proxy: Tunnel hängt → 503 nach Zeitüberschreitung', async () => {
  const store = new FakeStore()
  await online(store)
  const worker = createWorker({
    store: () => store,
    originTimeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('abgebrochen')))
      })
  })
  const res = await worker.fetch(new Request(`${BASE}/${T}`), { DB: null as never })
  assert.equal(res.status, 503)
})

test('proxy: gesperrter Link oder gesperrtes Gerät → 451, ohne Tunnel-Aufruf', async () => {
  const t = setup(() => new Response('x'))
  await online(t.store)
  t.store.blockedLinks.set(T, { reason: 'Urheberrechtsverletzung gemeldet', at: Date.UTC(2026, 10, 3, 12) })
  const res = await t.call(`/${T}`)
  assert.equal(res.status, 451)
  assert.equal(t.calls.length, 0)
  // Andere Links desselben Geräts bleiben erreichbar.
  const other = await t.call(`/${D}Other12345`)
  assert.equal(other.status, 200)

  const t2 = setup(() => new Response('x'))
  await online(t2.store)
  Object.assign(t2.store.devices.get(D)!, { blocked: true, blockReason: 'Schadsoftware' })
  assert.equal((await t2.call(`/${T}`)).status, 451)
  assert.equal((await t2.call(`/${T}/_font/Geist-Variable.woff2`)).status, 451)
  assert.equal(t2.calls.length, 0)
})

test('proxy: POST und andere Methoden auf Relay-Pfaden → 405', async () => {
  const t = setup(() => new Response('x'))
  await online(t.store)
  for (const p of [`/${T}`, `/${T}/d`]) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await t.call(p, { method, body: method === 'POST' || method === 'PUT' ? 'x' : undefined })
      assert.equal(res.status, 405, method)
      assert.equal(res.headers.get('Allow'), 'GET, HEAD')
    }
  }
  assert.equal(t.calls.length, 0)
})

test('proxy: falsche Adresse in der Datenbank wird nie angefragt', async () => {
  const t = setup(() => new Response('x'))
  await online(t.store, 'https://evil.com')
  assert.equal((await t.call(`/${T}`)).status, 503)
  assert.equal(t.calls.length, 0)
})

test('proxy: Geräte-Zuordnung wird kurz gemerkt, neue Adresse nach Fehler sofort genutzt', async () => {
  const NEW = 'https://new-tunnel.trycloudflare.com'
  const t = setup((url) =>
    url.startsWith(NEW) ? new Response('neu', { headers: { 'Content-Type': 'text/plain' } }) : new Response('', { status: 530 })
  )
  await online(t.store, NEW)
  await (await t.call(`/${T}/${F}`)).arrayBuffer()
  await (await t.call(`/${T}/${F}`)).arrayBuffer()
  assert.equal(t.store.lookups, 1, 'zweiter Aufruf aus dem Zwischenspeicher')

  // App neu gestartet: andere Adresse in der Datenbank, Zwischenspeicher veraltet.
  t.store.devices.get(D)!.url = 'https://old-dead.trycloudflare.com'
  t.tick(31_000)
  await (await t.call(`/${T}/${F}`)).arrayBuffer() // merkt sich die tote Adresse
  t.store.devices.get(D)!.url = NEW
  const res = await t.call(`/${T}/${F}`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'neu')
})

test('proxy: Volumenbremse je Netz, je Gerät und je Link → 429', async () => {
  const deny = { limit: async () => ({ success: false }) }
  for (const name of ['PROXY_LIMITER', 'DEVICE_LIMITER', 'LINK_LIMITER']) {
    const t = setup(() => new Response('x'))
    await online(t.store)
    for (const p of [`/${T}`, `/${T}/d`]) {
      const res = await t.worker.fetch(new Request(BASE + p), { ...t.env, [name]: deny })
      assert.equal(res.status, 429, `${name} ${p}`)
    }
    assert.equal(t.calls.length, 0)
    assert.equal(t.store.lookups, 0, 'gebremst wird vor der Datenbank')
  }
  // Schlüssel: Gerät und Link, keine IP im Klartext.
  const keys: string[] = []
  const spy = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) }
  const t = setup(() => new Response('x', { headers: { 'Content-Type': 'text/html' } }))
  await online(t.store)
  await t.worker.fetch(new Request(`${BASE}/${T}`, { headers: { 'CF-Connecting-IP': '203.0.113.7' } }), {
    ...t.env,
    PROXY_LIMITER: spy,
    DEVICE_LIMITER: spy,
    LINK_LIMITER: spy
  })
  assert.equal(keys.length, 3)
  assert.ok(keys.includes(`d:${D}`))
  assert.ok(keys.includes(`l:${T}`))
  assert.ok(keys.every((k) => !k.includes('203.0.113')))
  // Ein kaputtes Binding hält nichts auf.
  const broken = { limit: async () => Promise.reject(new Error('x')) }
  const ok = await t.worker.fetch(new Request(`${BASE}/${T}`), { ...t.env, LINK_LIMITER: broken })
  assert.equal(ok.status, 200)
})

test('proxy: HTMLRewriter entfernt meta-refresh, link und base aus Seiten', async () => {
  const removed: string[] = []
  const handlers: Record<string, (el: { getAttribute(n: string): string | null; remove(): void }) => void> = {}
  class FakeRewriter {
    on(sel: string, h: { element(el: unknown): void }) {
      handlers[sel] = h.element as never
      return this
    }
    transform(res: Response) {
      return res
    }
  }
  const g = globalThis as { HTMLRewriter?: unknown }
  g.HTMLRewriter = FakeRewriter
  try {
    const t = setup(() => new Response('<p>x</p>', { headers: { 'Content-Type': 'text/html', 'Content-Length': '8' } }))
    await online(t.store)
    const res = await t.call(`/${T}`)
    assert.equal(res.headers.get('Content-Length'), null)
    const el = (attr: string | null, tag: string) => ({
      getAttribute: (n: string) => (n === 'http-equiv' ? attr : null),
      remove: () => removed.push(tag)
    })
    handlers.meta(el('refresh', 'meta-refresh'))
    handlers.meta(el(null, 'meta-viewport'))
    handlers.link(el(null, 'link'))
    handlers.base(el(null, 'base'))
    assert.deepEqual(removed, ['meta-refresh', 'link', 'base'])
  } finally {
    delete g.HTMLRewriter
  }
})

// ---- Seiten ------------------------------------------------------------------

function assertNoScript(html: string) {
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i)
  assert.doesNotMatch(html, /(?:href|src)="\s*javascript:/i)
}

test('seiten: / leitet auf /_/, Info-Seite mit den Texten und Betreiber-Links', async () => {
  const t = setup(undefined, { SOURCE_URL: 'https://github.com/example/foldwing' })
  const root = await t.call('/')
  assert.equal(root.status, 302)
  assert.equal(root.headers.get('Location'), '/_/')

  const res = await t.call('/_/')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8')
  assert.match(res.headers.get('Content-Security-Policy')!, /script-src 'none'/)
  assert.match(res.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/)
  assert.equal(res.headers.get('X-Robots-Tag'), 'noindex, nofollow')
  const html = await res.text()
  assertNoScript(html)
  assert.match(html, /<title>Über share\.example\.com<\/title>/)
  assert.match(html, /Dateien teilen, die bei dir bleiben/)
  assert.match(html, /Er speichert keine Dateien und schaut nicht hinein\./)
  assert.match(html, /href="https:\/\/example\.com\/impressum"/)
  assert.match(html, /href="https:\/\/example\.com\/datenschutz"/)
  assert.match(html, /href="https:\/\/example\.com\/regeln"/)
  assert.match(html, /href="https:\/\/github\.com\/example\/foldwing"/)
  assert.match(html, /<!--email_off--><code>abuse@example\.com<\/code><!--email_on-->/)
  assert.match(html, /href="\/_\/melden"/)
  assert.match(html, /prefers-color-scheme: dark/)
  assert.match(html, /name="viewport"/)
})

test('seiten: Kurzwege /_/impressum, /_/datenschutz, /_/regeln', async () => {
  const t = setup()
  for (const [p, loc] of [
    ['/_/impressum', 'https://example.com/impressum'],
    ['/_/datenschutz', 'https://example.com/datenschutz'],
    ['/_/regeln', 'https://example.com/regeln']
  ]) {
    const res = await t.call(p)
    assert.equal(res.status, 302, p)
    assert.equal(res.headers.get('Location'), loc)
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
  }
  const unset = setup(undefined, { IMPRINT_URL: '', PRIVACY_URL: 'javascript:alert(1)', TERMS_URL: 'http://example.com/x' })
  for (const p of ['/_/impressum', '/_/datenschutz', '/_/regeln']) {
    const res = await unset.call(p)
    assert.equal(res.status, 404, p)
    assert.equal(res.headers.get('Location'), null)
  }
})

test('seiten: Betreiber-Angaben fehlen oder sind unsicher → nichts Gefährliches', async () => {
  const t = setup(undefined, {
    IMPRINT_URL: 'javascript:alert(1)',
    PRIVACY_URL: 'http://example.com/unsicher',
    TERMS_URL: '',
    CONTACT_EMAIL: 'nicht"eine@adresse'
  })
  const info = await (await t.call('/_/')).text()
  assertNoScript(info)
  assert.doesNotMatch(info, /http:\/\/example\.com\/unsicher/)
  assert.match(info, /noch keine Kontaktadresse/)
  const report = await (await t.call(`/_/melden?l=${T}`)).text()
  assertNoScript(report)
  assert.match(report, /noch keine Kontaktadresse/)
  assert.doesNotMatch(report, /mailto:/)
})

test('seiten: Melde-Seite füllt die Mail vor und escaped den l-Parameter', async () => {
  const t = setup()
  const res = await t.call(`/_/melden?l=${T}`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assertNoScript(html)
  assert.match(html, new RegExp(`Gemeldeter Link:</strong> <code>https://share\\.example\\.com/${T}</code>`))
  const href = /href="(mailto:[^"]+)"/.exec(html)![1].replace(/&amp;/g, '&')
  const mail = new URL(href)
  assert.equal(mail.pathname, 'abuse@example.com')
  assert.equal(mail.searchParams.get('subject'), `Meldung share.example.com: ${T}`)
  const body = mail.searchParams.get('body')!
  assert.match(body, new RegExp(`^Link: https://share\\.example\\.com/${T}\\n`))
  assert.match(body, /Ich bin in gutem Glauben überzeugt, dass meine Angaben richtig und vollständig sind\./)
  assert.match(html, /<!--email_off-->/)
  assert.match(html, /Ruf 110 an\./)

  for (const evil of [
    '"><script>alert(1)</script>',
    "'><img src=x onerror=alert(1)>",
    `${T}"><b>x</b>`,
    'javascript:alert(1)'
  ]) {
    const r = await t.call(`/_/melden?l=${encodeURIComponent(evil)}`)
    assert.equal(r.status, 200)
    const page = await r.text()
    assertNoScript(page)
    assert.doesNotMatch(page, /<b>x<\/b>/)
    assert.doesNotMatch(page, /<img src=x/)
    assert.doesNotMatch(page, /Gemeldeter Link/)
  }
})

test('seiten: 451 zeigt Grund und Datum (escaped) und wie man widerspricht', async () => {
  const t = setup()
  await online(t.store)
  t.store.blockedLinks.set(T, { reason: '<b>Schadsoftware</b>', at: Date.UTC(2026, 10, 3, 12) })
  const res = await t.call(`/${T}`)
  assert.equal(res.status, 451)
  const html = await res.text()
  assertNoScript(html)
  assert.match(html, /Dieser Link wurde gesperrt\./)
  assert.match(html, /Ich habe ihn am 3\. November 2026 gesperrt\. Grund: &lt;b&gt;Schadsoftware&lt;\/b&gt;\./)
  assert.doesNotMatch(html, /<b>Schadsoftware/)
  assert.match(html, /hältst die Sperre für falsch\? Schreib mir an <!--email_off--><code>abuse@example\.com<\/code>/)
  assert.match(html, new RegExp(`<code>https://share\\.example\\.com/${T}</code>`))

  // Gerät gesperrt, ohne Datum: Satz bleibt vollständig.
  const t2 = setup()
  await online(t2.store)
  Object.assign(t2.store.devices.get(D)!, { blocked: true, blockReason: 'Verstoß gegen die Regeln' })
  const html2 = await (await t2.call(`/${T}`)).text()
  assert.match(html2, /Ich habe ihn gesperrt\. Grund: Verstoß gegen die Regeln\./)
})

test('seiten: 404, 405, HEAD und robots.txt', async () => {
  const t = setup()
  const nf = await t.call('/irgendwas')
  assert.equal(nf.status, 404)
  assert.equal(nf.headers.get('X-Robots-Tag'), 'noindex, nofollow')
  assertNoScript(await nf.text())
  const post = await t.call('/_/', { method: 'POST', body: 'x' })
  assert.equal(post.status, 405)
  const head = await t.call('/_/', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
  assert.ok(Number(head.headers.get('Content-Length')) > 500)
  const robots = await t.call('/robots.txt')
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n')
  assert.equal(robots.headers.get('X-Robots-Tag'), 'noindex, nofollow')
  const api = await t.call('/_/api/sonstwas', { method: 'POST' })
  assert.equal(api.status, 404)
  assert.equal(api.headers.get('X-Robots-Tag'), 'noindex, nofollow')
})

test('seiten: Fehler in der Datenbank → 503 ohne Interna', async () => {
  const store = new FakeStore()
  store.lookup = async () => {
    throw new Error('D1_ERROR: geheimes Detail')
  }
  store.getDevice = store.lookup as never
  const worker = createWorker({ store: () => store })
  const page = await worker.fetch(new Request(`${BASE}/${T}`), { DB: null as never })
  assert.equal(page.status, 503)
  assert.doesNotMatch(await page.text(), /geheimes Detail/)
  const api = await worker.fetch(
    new Request(`${BASE}/_/api/register`, { method: 'POST', body: JSON.stringify({ id: D, secret: SECRET, url: TUNNEL }) }),
    { DB: null as never }
  )
  assert.equal(api.status, 503)
  assert.deepEqual(await api.json(), { ok: false, error: 'unavailable' })
})

// ---- Cron --------------------------------------------------------------------

test('cron: löscht nur nicht gesperrte Geräte, die 30 Tage nicht gesehen wurden', async () => {
  const t = setup()
  const day = 24 * 60 * 60 * 1000
  const now = t.now()
  t.store.devices.set('OldOld01', { secretHash: 'h', url: null, online: false, blocked: false, seenAt: now - 31 * day })
  t.store.devices.set('OldBlk01', { secretHash: 'h', url: null, online: false, blocked: true, seenAt: now - 90 * day })
  t.store.devices.set('NewNew01', { secretHash: 'h', url: null, online: true, blocked: false, seenAt: now - 29 * day })
  const pending: Promise<unknown>[] = []
  await t.worker.scheduled({ scheduledTime: now, cron: '17 3 * * *' }, t.env, { waitUntil: (p) => pending.push(p) })
  await Promise.all(pending)
  assert.deepEqual([...t.store.devices.keys()].sort(), ['NewNew01', 'OldBlk01'])
})

// ---- D1Store gegen echtes SQLite ----------------------------------------------

async function sqliteD1() {
  let sqlite: typeof import('node:sqlite')
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return null
  }
  const db = new sqlite.DatabaseSync(':memory:')
  db.exec(readFileSync(join(ROOT, 'worker', 'relay', 'schema.sql'), 'utf8'))
  const d1 = {
    prepare(sql: string) {
      let params: unknown[] = []
      const stmt = {
        bind(...v: unknown[]) {
          params = v
          return stmt
        },
        async first() {
          return (db.prepare(sql).get(...(params as never[])) as Record<string, unknown>) ?? null
        },
        async run() {
          const r = db.prepare(sql).run(...(params as never[]))
          return { success: true, meta: { changes: Number(r.changes) } }
        },
        async all() {
          return { results: db.prepare(sql).all(...(params as never[])) }
        }
      }
      return stmt
    }
  }
  return { db, d1 }
}

test('D1Store: SQL gegen das echte Schema (node:sqlite)', async (t) => {
  const s = await sqliteD1()
  if (!s) {
    t.skip('node:sqlite nicht verfügbar')
    return
  }
  const store = new D1Store(s.d1 as never)
  assert.deepEqual(await store.lookup(D, T), { device: null, linkBlocked: false, block: null })
  assert.equal(await store.getDevice(D), null)

  assert.equal(await store.upsertDevice(D, 'hash1', TUNNEL, 100), true)
  assert.deepEqual(await store.lookup(D, T), {
    device: { url: TUNNEL, online: true, blocked: false },
    linkBlocked: false,
    block: null
  })
  // Gleicher Hash: Update. Anderer Hash: nichts ändert sich.
  assert.equal(await store.upsertDevice(D, 'hash1', 'https://b.trycloudflare.com', 200), true)
  assert.equal(await store.upsertDevice(D, 'hash2', 'https://evil.trycloudflare.com', 300), false)
  const dev = await store.getDevice(D)
  assert.equal(dev?.url, 'https://b.trycloudflare.com')
  assert.equal(dev?.secretHash, 'hash1')
  const row = s.db.prepare('SELECT created_at, seen_at FROM devices WHERE id = ?').get(D) as Record<string, number>
  assert.deepEqual({ ...row }, { created_at: 100, seen_at: 200 })

  await store.setOffline(D, 'hash2')
  assert.equal((await store.getDevice(D))?.online, true)
  await store.setOffline(D, 'hash1')
  assert.equal((await store.getDevice(D))?.online, false)

  // Gesperrt: kein Update mehr, auch mit richtigem Hash.
  s.db.prepare("UPDATE devices SET blocked = 1, block_reason = 'Schadsoftware', blocked_at = 7 WHERE id = ?").run(D)
  assert.equal(await store.upsertDevice(D, 'hash1', TUNNEL, 400), false)
  assert.deepEqual(await store.lookup(D, 'OtherLink12345678x'), {
    device: { url: 'https://b.trycloudflare.com', online: false, blocked: true },
    linkBlocked: false,
    block: { reason: 'Schadsoftware', at: 7 }
  })
  // Link-Sperre geht vor (genauer).
  s.db.prepare('INSERT INTO blocked_links (token, reason, created_at) VALUES (?, ?, ?)').run(T, 'Betrug oder Phishing', 9)
  assert.deepEqual(await store.lookup(D, T), {
    device: { url: 'https://b.trycloudflare.com', online: false, blocked: true },
    linkBlocked: true,
    block: { reason: 'Betrug oder Phishing', at: 9 }
  })
  // Link gesperrt, Gerät unbekannt.
  assert.deepEqual(await store.lookup('Unknown1', T), {
    device: null,
    linkBlocked: true,
    block: { reason: 'Betrug oder Phishing', at: 9 }
  })

  await store.upsertDevice('Stale001', 'h', TUNNEL, 10)
  assert.equal(await store.deleteStale(150), 1) // D ist gesperrt und bleibt
  assert.equal(await store.getDevice('Stale001'), null)
  assert.notEqual(await store.getDevice(D), null)
})

// ---- Moderations-Skript --------------------------------------------------------

test('moderate: Eingaben werden streng geprüft', () => {
  assert.deepEqual(parseTarget(T), { kind: 'link', token: T, device: D })
  assert.deepEqual(parseTarget(`${BASE}/${T}/${F}/d?dl=1`), { kind: 'link', token: T, device: D })
  assert.deepEqual(parseTarget(D), { kind: 'device', device: D })
  for (const bad of ["Dev1ce4'", `${T}x`, 'abc', `${D}; DROP TABLE devices`, '', 'https://evil.com/x']) {
    assert.equal(parseTarget(bad), null, bad)
  }
  assert.equal(categoryText('urheberrecht'), 'Urheberrechtsverletzung gemeldet')
  assert.equal(categoryText('Missbrauch'), 'Verstoß gegen das Gesetz') // ohne Details
  for (const bad of ["x'; DROP TABLE devices; --", 'Spam', '', 'constructor', '__proto__']) {
    assert.equal(categoryText(bad), null, bad)
  }
  const sql = buildSql('block', parseTarget(T), categoryText('schadsoftware'), 1234)
  assert.match(sql, /INSERT INTO blocked_links/)
  assert.match(sql, /'Dev1ce42Share12345'/)
  assert.match(sql, /'Schadsoftware'/)
  assert.throws(() => buildSql('block', parseTarget(T), "x'); DROP TABLE devices; --", 1))
  const dev = buildSql('block', parseTarget(D), categoryText('regeln'), 1234)
  assert.match(dev, /blocked_at = excluded\.blocked_at/)
  assert.match(dev, /1234, 1, 'Verstoß gegen die Regeln', 1234\)/)
})
