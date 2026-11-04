#!/usr/bin/env node
// Moderation für den Foldwing-Relay: Links oder Geräte sperren, entsperren, ansehen.
// Notweg über die Kommandozeile; dieselbe Logik mit gebundenem SQL steht in
// worker/relay/src/moderation.ts (RPC-Einstieg Admin). Kategorien und parseTarget
// müssen in beiden gleich bleiben (tests/relay-admin.test.ts).
//
//   node worker/scripts/moderate.mjs block   <link|T|D> <kategorie>
//   node worker/scripts/moderate.mjs unblock <link|T|D>
//   node worker/scripts/moderate.mjs list
//   node worker/scripts/moderate.mjs lookup  <link|T|D>
//
// Optionen: --db <name> (Standard foldwing-relay), --local (lokale D1 statt --remote),
// alles nach `--` geht unverändert an wrangler (z. B. `-- -c pfad/wrangler.toml`).
//
// Ein Link oder T (18 Zeichen) sperrt genau diesen Link; D (8 Zeichen) sperrt das
// ganze Gerät mit allen Links. Der Grund ist eine Kategorie aus einer festen Liste
// (kein Freitext – er steht öffentlich auf der 451-Seite). Ruft
// `npx wrangler d1 execute … --command …` auf – ohne Shell, mit Argument-Liste.
// In das SQL gelangen nur geprüfte base62-Kennungen und die festen Kategorie-Texte.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'relay')
const TOKEN = /^[A-Za-z0-9]{18}$/
const DEVICE = /^[A-Za-z0-9]{8}$/

/**
 * Ziel aus Link, T oder D. Ergebnis `{ kind: 'link', token, device }`,
 * `{ kind: 'device', device }` oder null.
 */
export function parseTarget(input) {
  const s = String(input ?? '').trim()
  if (TOKEN.test(s)) return { kind: 'link', token: s, device: s.slice(0, 8) }
  if (DEVICE.test(s)) return { kind: 'device', device: s }
  if (!/^https?:\/\//i.test(s) || s.length > 500) return null
  let path
  try {
    path = new URL(s).pathname
  } catch {
    return null
  }
  const m = /^\/([A-Za-z0-9]{18})(?:\/|$)/.exec(path)
  return m ? { kind: 'link', token: m[1], device: m[1].slice(0, 8) } : null
}

/**
 * Sperrgründe, wie sie auf der 451-Seite stehen. Bei Missbrauchsdarstellungen
 * bewusst nur „Verstoß gegen das Gesetz“, ohne Details.
 */
export const CATEGORIES = {
  urheberrecht: 'Urheberrechtsverletzung gemeldet',
  schadsoftware: 'Schadsoftware',
  betrug: 'Betrug oder Phishing',
  persoenlichkeitsrecht: 'Verletzung von Persönlichkeitsrechten',
  gesetz: 'Verstoß gegen das Gesetz',
  missbrauch: 'Verstoß gegen das Gesetz',
  regeln: 'Verstoß gegen die Regeln'
}

/** Kategorie-Schlüssel → Text, sonst null. */
export function categoryText(key) {
  const k = String(key ?? '').trim().toLowerCase()
  return Object.hasOwn(CATEGORIES, k) ? CATEGORIES[k] : null
}

const REASONS = new Set(Object.values(CATEGORIES))

const q = (s) => `'${s}'`

/** SQL für eine Aktion. `target` und `reason` müssen schon geprüft sein. */
export function buildSql(action, target, reason, now = Date.now()) {
  if (target && !(target.kind === 'link' ? TOKEN.test(target.token) : true)) throw new Error('Ziel ungültig')
  if (target && !DEVICE.test(target.device)) throw new Error('Ziel ungültig')
  if (reason !== undefined && reason !== null && !REASONS.has(reason)) throw new Error('Grund ungültig')
  if (!Number.isSafeInteger(now)) throw new Error('Zeit ungültig')
  const why = reason ? q(reason) : 'NULL'
  const deviceCols = 'id, url, online, blocked, block_reason, blocked_at, created_at, seen_at'
  switch (action) {
    case 'block':
      if (target.kind === 'link') {
        return (
          `INSERT INTO blocked_links (token, reason, created_at) VALUES (${q(target.token)}, ${why}, ${now}) ` +
          'ON CONFLICT(token) DO UPDATE SET reason = excluded.reason'
        )
      }
      // Auch ein (noch) unbekanntes Gerät lässt sich sperren: Platzhalter-Eintrag mit
      // ungültigem Hash – eine spätere Anmeldung scheitert dann an der Sperre.
      return (
        'INSERT INTO devices (id, secret_hash, url, online, created_at, seen_at, blocked, block_reason, blocked_at) ' +
        `VALUES (${q(target.device)}, '-', NULL, 0, ${now}, ${now}, 1, ${why}, ${now}) ` +
        'ON CONFLICT(id) DO UPDATE SET blocked = 1, online = 0, block_reason = excluded.block_reason, ' +
        'blocked_at = excluded.blocked_at'
      )
    case 'unblock':
      if (target.kind === 'link') return `DELETE FROM blocked_links WHERE token = ${q(target.token)}`
      return (
        `DELETE FROM devices WHERE id = ${q(target.device)} AND secret_hash = '-'; ` +
        `UPDATE devices SET blocked = 0, block_reason = NULL, blocked_at = NULL WHERE id = ${q(target.device)}`
      )
    case 'lookup':
      return (
        `SELECT ${deviceCols} FROM devices WHERE id = ${q(target.device)}; ` +
        (target.kind === 'link'
          ? `SELECT token, reason, created_at FROM blocked_links WHERE token = ${q(target.token)}`
          : `SELECT token, reason, created_at FROM blocked_links WHERE token LIKE ${q(target.device + '%')}`)
      )
    case 'list':
      return (
        'SELECT id, block_reason, blocked_at, seen_at FROM devices WHERE blocked = 1 ORDER BY id; ' +
        'SELECT token, reason, created_at FROM blocked_links ORDER BY created_at DESC'
      )
    default:
      throw new Error('Unbekannte Aktion')
  }
}

/** npx ohne Shell starten: über node und npx-cli.js (unter Windows ist npx eine .cmd). */
function npxCommand() {
  const nodeDir = dirname(process.execPath)
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
  ]
  const cli = candidates.find((p) => existsSync(p))
  if (cli) return { cmd: process.execPath, pre: [cli] }
  if (process.platform !== 'win32') return { cmd: 'npx', pre: [] }
  return null
}

function formatValue(key, value) {
  if (value !== null && /_at$/.test(key) && typeof value === 'number') return new Date(value).toISOString()
  return value
}

function usage(code = 1) {
  console.log(`Aufruf:
  node worker/scripts/moderate.mjs block   <link|T|D> <kategorie>
  node worker/scripts/moderate.mjs unblock <link|T|D>
  node worker/scripts/moderate.mjs list
  node worker/scripts/moderate.mjs lookup  <link|T|D>

Kategorien: ${Object.keys(CATEGORIES).join(', ')}
Optionen: --db <name>, --local, -- <weitere wrangler-Argumente>`)
  process.exit(code)
}

function main(argv) {
  const passIdx = argv.indexOf('--')
  const own = passIdx === -1 ? argv : argv.slice(0, passIdx)
  const passthrough = passIdx === -1 ? [] : argv.slice(passIdx + 1)

  let db = 'foldwing-relay'
  let local = false
  const rest = []
  for (let i = 0; i < own.length; i++) {
    if (own[i] === '--db') db = own[++i] ?? ''
    else if (own[i] === '--local') local = true
    else if (own[i] === '-h' || own[i] === '--help') usage(0)
    else rest.push(own[i])
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(db)) {
    console.error('Ungültiger Datenbankname.')
    process.exit(1)
  }

  const [action, rawTarget, ...reasonParts] = rest
  if (!['block', 'unblock', 'list', 'lookup'].includes(action)) usage()
  let target = null
  if (action !== 'list') {
    target = parseTarget(rawTarget)
    if (!target) {
      console.error('Das ist weder ein Relay-Link noch eine ID (18 Zeichen für einen Link, 8 für ein Gerät).')
      process.exit(1)
    }
  }
  let reason = null
  if (action === 'block') {
    reason = reasonParts.length === 1 ? categoryText(reasonParts[0]) : null
    if (reason === null) {
      console.error(`Gib genau eine Kategorie an: ${Object.keys(CATEGORIES).join(', ')}`)
      process.exit(1)
    }
  } else if (reasonParts.length) {
    usage()
  }

  const sql = buildSql(action, target, reason)
  const npx = npxCommand()
  if (!npx) {
    console.error('npx nicht gefunden.')
    process.exit(1)
  }
  const args = [
    ...npx.pre,
    '--yes',
    'wrangler@4',
    'd1',
    'execute',
    db,
    local ? '--local' : '--remote',
    '--json',
    '--command',
    sql,
    ...passthrough
  ]
  const r = spawnSync(npx.cmd, args, { cwd: RELAY_DIR, encoding: 'utf8', shell: false })
  if (r.error || r.status !== 0) {
    console.error('wrangler ist fehlgeschlagen.')
    if (r.stderr) console.error(r.stderr.trim())
    if (r.stdout) console.error(r.stdout.trim())
    process.exit(1)
  }
  let out
  try {
    out = JSON.parse(r.stdout)
  } catch {
    console.log(r.stdout)
    return
  }
  const blocks = Array.isArray(out) ? out : [out]
  if (action === 'block' || action === 'unblock') {
    const what = target.kind === 'link' ? `Link ${target.token}` : `Gerät ${target.device}`
    console.log(action === 'block' ? `${what} ist gesperrt.` : `${what} ist entsperrt.`)
    console.log('Hinweis: Bis zu 30 Sekunden kann der Relay noch die alte Zuordnung kennen.')
    return
  }
  const titles = action === 'list' ? ['Gesperrte Geräte', 'Gesperrte Links'] : ['Gerät', 'Gesperrte Links']
  blocks.forEach((b, i) => {
    const rows = (b.results ?? []).map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, formatValue(k, v)]))
    )
    console.log(`\n${titles[i] ?? 'Ergebnis'}:`)
    if (rows.length) console.table(rows)
    else console.log('  (keine)')
  })
}

// Nur als Skript starten, nicht beim Import (die Tests bündeln diese Datei mit ein).
const invoked = process.argv[1] ?? ''
if (/moderate\.mjs$/.test(invoked) && import.meta.url === pathToFileURL(invoked).href) {
  main(process.argv.slice(2))
}
