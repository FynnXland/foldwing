// Tests für die Moderation des Relays (worker/relay/src/moderation.ts), die der
// RPC-Einstieg `Admin` in worker.ts aufruft. Datenbank: node:sqlite mit schema.sql
// hinter einer kleinen D1-Attrappe. Dazu der Gleichlauf mit worker/scripts/moderate.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { D1Store } from '../worker/relay/src/index'
import { Moderation, CATEGORIES, parseTarget, categoryText } from '../worker/relay/src/moderation'
// @ts-ignore – reines JS-Modul ohne Typen
import * as script from '../worker/scripts/moderate.mjs'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

const D = 'Dev1ce42'
const T = D + 'Share12345'
const T2 = D + 'Other67890'
const OTHER = 'Zz9Yy8Xx'
const TUNNEL = 'https://brave-blue-otter-one.trycloudflare.com'
const HASH = 'a'.repeat(64)

async function sqliteD1() {
  let sqlite: typeof import('node:sqlite')
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return null
  }
  const db = new sqlite.DatabaseSync(':memory:')
  db.exec(readFileSync(join(ROOT, 'worker', 'relay', 'schema.sql'), 'utf8'))
  const prepare = (sql: string) => {
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
        return { results: db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[] }
      }
    }
    return stmt
  }
  const d1 = {
    prepare,
    async batch(stmts: ReturnType<typeof prepare>[]) {
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of stmts) out.push(await s.run())
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    }
  }
  return { db, d1 }
}

async function setup(t: { skip(msg: string): void }) {
  const s = await sqliteD1()
  if (!s) {
    t.skip('node:sqlite nicht verfügbar')
    return null
  }
  let clock = 1_000
  const mod = new Moderation(s.d1 as never, () => clock)
  const store = new D1Store(s.d1 as never)
  return { ...s, mod, store, tick: (ms = 1) => (clock += ms) }
}

// ---- Gleichlauf mit moderate.mjs ---------------------------------------------

test('Admin: Kategorien und Zielerkennung gleich wie in moderate.mjs', () => {
  assert.deepEqual({ ...CATEGORIES }, script.CATEGORIES)
  assert.deepEqual(Object.keys(CATEGORIES), Object.keys(script.CATEGORIES)) // auch die Reihenfolge
  const inputs: unknown[] = [
    T,
    D,
    ` ${T} `,
    `https://foldwing.online/${T}`,
    `https://share.fynn.land/${T}/Fil3ab/d?dl=1`,
    `HTTP://example.com/${T}`,
    `https://foldwing.online/${D}`,
    `https://foldwing.online/_/melden?l=${T}`,
    'https://foldwing.online/',
    'https://[nicht-gültig/x',
    'ftp://example.com/' + T,
    'https://example.com/' + 'a'.repeat(600),
    `${T}x`,
    "Dev1ce4'",
    `${D}; DROP TABLE devices`,
    '',
    null,
    undefined,
    12345678,
    {}
  ]
  for (const x of inputs) assert.deepEqual(parseTarget(x), script.parseTarget(x), String(x))
  for (const k of ['urheberrecht', 'MISSBRAUCH', ' regeln ', 'Spam', '', 'constructor', '__proto__', null]) {
    assert.equal(categoryText(k), script.categoryText(k), String(k))
  }
})

// ---- Methoden ----------------------------------------------------------------

test('Admin: categories in fester Reihenfolge', async () => {
  const mod = new Moderation({} as never)
  const r = await mod.categories()
  assert.equal(r.ok, true)
  assert.deepEqual(
    r.categories.map((c) => c.key),
    Object.keys(CATEGORIES)
  )
  assert.equal(r.categories.find((c) => c.key === 'missbrauch')?.text, 'Verstoß gegen das Gesetz')
})

test('Admin: falsche Ziele und Kategorien kommen als Fehler, nie als Ausnahme', async (t) => {
  const s = await setup(t)
  if (!s) return
  for (const bad of ['abc', `${D}'--`, '', null, 42, 'https://evil.example/x']) {
    assert.deepEqual(
      { ...(await s.mod.lookup(bad)), error: undefined },
      { ok: false, code: 'badTarget', error: undefined }
    )
    assert.equal((await s.mod.block(bad, 'regeln')).ok, false)
    assert.equal(((await s.mod.unblock(bad)) as { code?: string }).code, 'badTarget')
  }
  for (const bad of ['Spam', '', "x'; DROP TABLE devices; --", '__proto__', undefined]) {
    const r = await s.mod.block(T, bad)
    assert.equal(r.ok, false)
    assert.equal((r as { code: string }).code, 'badCategory')
  }
  // Nichts wurde geschrieben.
  assert.deepEqual(await s.mod.counts(), { ok: true, devices: 0, online: 0, blockedDevices: 0, blockedLinks: 0 })
})

test('Admin: Datenbankfehler werden zu serverError, ohne Details', async () => {
  const broken = {
    prepare() {
      throw new Error('SQLITE_ERROR: geheimes Detail')
    },
    batch() {
      return Promise.reject(new Error('geheim'))
    }
  }
  const mod = new Moderation(broken as never)
  for (const r of [await mod.counts(), await mod.list(), await mod.lookup(T), await mod.block(D, 'regeln'), await mod.unblock(D)]) {
    assert.equal(r.ok, false)
    assert.equal((r as { code: string }).code, 'serverError')
    assert.doesNotMatch(JSON.stringify(r), /geheim|SQLITE/)
  }
})

test('Admin: Link sperren, nachschlagen, Grund ändern, entsperren', async (t) => {
  const s = await setup(t)
  if (!s) return
  await s.store.upsertDevice(D, HASH, TUNNEL, 500)

  assert.deepEqual(await s.mod.block(`https://foldwing.online/${T}`, 'urheberrecht'), {
    ok: true,
    target: { kind: 'link', token: T, device: D },
    reason: 'Urheberrechtsverletzung gemeldet'
  })
  s.tick()
  await s.mod.block(T2, 'betrug')
  // Der Relay sieht die Sperre (gleiche Tabelle wie moderate.mjs).
  assert.equal((await s.store.lookup(D, T)).linkBlocked, true)

  const look = await s.mod.lookup(T)
  assert.equal(look.ok, true)
  if (!look.ok) return
  assert.deepEqual(look.links, [{ token: T, reason: 'Urheberrechtsverletzung gemeldet', blockedAt: 1000 }])
  assert.deepEqual(look.device, {
    id: D,
    online: true,
    blocked: false,
    reason: null,
    blockedAt: null,
    createdAt: 500,
    seenAt: 500
  })
  // Tunnel-Adresse und Hash gehen nie hinaus.
  assert.doesNotMatch(JSON.stringify(look), /trycloudflare|aaaaaaaa/)

  // Nachschlagen über das Gerät zeigt alle gesperrten Links, neueste zuerst.
  const byDevice = await s.mod.lookup(D)
  assert.equal(byDevice.ok && byDevice.links.map((l) => l.token).join(), [T2, T].join())

  // Erneut sperren ändert nur den Grund, nicht den Zeitpunkt.
  await s.mod.block(T, 'schadsoftware')
  const again = await s.mod.lookup(T)
  assert.deepEqual(again.ok && again.links, [{ token: T, reason: 'Schadsoftware', blockedAt: 1000 }])

  const list = await s.mod.list()
  assert.deepEqual(list.ok && list.links.map((l) => l.token), [T2, T])
  assert.deepEqual(list.ok && list.devices, [])

  assert.deepEqual(await s.mod.unblock(T), { ok: true, target: { kind: 'link', token: T, device: D }, changed: true })
  const second = await s.mod.unblock(T)
  assert.equal(second.ok && second.changed, false)
  assert.equal((await s.store.lookup(D, T)).linkBlocked, false)
})

test('Admin: unbekanntes Gerät sperren legt einen Platzhalter an, Entsperren löscht ihn', async (t) => {
  const s = await setup(t)
  if (!s) return
  await s.store.upsertDevice(D, HASH, TUNNEL, 500)

  assert.deepEqual(await s.mod.block(OTHER, 'MISSBRAUCH'), {
    ok: true,
    target: { kind: 'device', device: OTHER },
    reason: 'Verstoß gegen das Gesetz'
  })
  assert.deepEqual(await s.mod.counts(), { ok: true, devices: 1, online: 1, blockedDevices: 1, blockedLinks: 0 })
  // Eine spätere Anmeldung mit diesem Gerät scheitert.
  assert.equal(await s.store.upsertDevice(OTHER, HASH, TUNNEL, 2000), false)

  const list = await s.mod.list()
  assert.deepEqual(list.ok && list.devices, [{ id: OTHER, reason: 'Verstoß gegen das Gesetz', blockedAt: 1000, seenAt: 1000 }])

  const r = await s.mod.unblock(OTHER)
  assert.equal(r.ok && r.changed, true)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE id = ?').get(OTHER)?.n, 0)
  const again = await s.mod.unblock(OTHER)
  assert.equal(again.ok && again.changed, false)
})

test('Admin: echtes Gerät sperren und entsperren, der Hash bleibt stehen', async (t) => {
  const s = await setup(t)
  if (!s) return
  await s.store.upsertDevice(D, HASH, TUNNEL, 500)
  await s.mod.block(T, 'regeln') // ein Link-Sperre bleibt beim Geräte-Entsperren unberührt

  await s.mod.block(D, 'schadsoftware')
  const row = () => s.db.prepare('SELECT secret_hash, online, blocked, block_reason, blocked_at FROM devices WHERE id = ?').get(D)
  assert.deepEqual({ ...row() }, { secret_hash: HASH, online: 0, blocked: 1, block_reason: 'Schadsoftware', blocked_at: 1000 })
  assert.deepEqual(await s.mod.counts(), { ok: true, devices: 1, online: 0, blockedDevices: 1, blockedLinks: 1 })
  assert.equal(await s.store.upsertDevice(D, HASH, TUNNEL, 3000), false)

  const look = await s.mod.lookup(D)
  assert.equal(look.ok && look.device?.blocked, true)
  assert.equal(look.ok && look.device?.reason, 'Schadsoftware')
  assert.deepEqual(look.ok && look.links.map((l) => l.token), [T])

  const r = await s.mod.unblock(D)
  assert.deepEqual(r, { ok: true, target: { kind: 'device', device: D }, changed: true })
  assert.deepEqual({ ...row() }, { secret_hash: HASH, online: 0, blocked: 0, block_reason: null, blocked_at: null })
  // Nicht gesperrt: Entsperren ändert nichts.
  const again = await s.mod.unblock(D)
  assert.equal(again.ok && again.changed, false)
  // Die Link-Sperre steht noch, die App kann sich wieder anmelden.
  assert.equal((await s.store.lookup(D, T)).linkBlocked, true)
  assert.equal(await s.store.upsertDevice(D, HASH, TUNNEL, 4000), true)
})

test('Admin: worker.ts exportiert den Relay und den Einstieg Admin', () => {
  const src = readFileSync(join(ROOT, 'worker', 'relay', 'src', 'worker.ts'), 'utf8')
  assert.match(src, /export \{ default \} from '\.\/index'/)
  assert.match(src, /export class Admin extends WorkerEntrypoint<Env>/)
  for (const m of ['categories', 'counts', 'list', 'lookup', 'block', 'unblock']) {
    assert.match(src, new RegExp(`\\n  ${m}\\(`), m)
  }
  // Die Tunnel-Adresse liest der Einstieg nirgends aus.
  assert.doesNotMatch(readFileSync(join(ROOT, 'worker', 'relay', 'src', 'moderation.ts'), 'utf8'), /SELECT[^'"]*\burl\b/)
  const example = readFileSync(join(ROOT, 'worker', 'relay', 'wrangler.example.toml'), 'utf8')
  assert.match(example, /^main = "src\/worker\.ts"$/m)
})
