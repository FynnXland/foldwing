// Moderation des Relays: Links oder Geräte sperren, entsperren, nachschlagen.
// Dieselben Regeln wie worker/scripts/moderate.mjs (der Notweg über die Kommandozeile),
// aber mit gebundenen Parametern statt zusammengesetztem SQL. Aufgerufen wird das über
// den RPC-Einstieg `Admin` in worker.ts, den nur ein Service Binding erreicht.
//
// Liest und schreibt nur `devices` und `blocked_links`. Die Tunnel-Adresse und der Hash
// des Geräte-Geheimnisses verlassen dieses Modul nie.

import type { D1Database } from './env'

const TOKEN = /^[A-Za-z0-9]{18}$/
const DEVICE = /^[A-Za-z0-9]{8}$/

/** Höchstzahl Einträge je Liste in `list()`. */
const LIST_LIMIT = 1000

export type Target = { kind: 'link'; token: string; device: string } | { kind: 'device'; device: string }

/** Ziel aus Link, T (18 Zeichen) oder D (8 Zeichen); sonst null. Wie parseTarget in moderate.mjs. */
export function parseTarget(input: unknown): Target | null {
  const s = String(input ?? '').trim()
  if (TOKEN.test(s)) return { kind: 'link', token: s, device: s.slice(0, 8) }
  if (DEVICE.test(s)) return { kind: 'device', device: s }
  if (!/^https?:\/\//i.test(s) || s.length > 500) return null
  let path: string
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
 * bewusst nur „Verstoß gegen das Gesetz“, ohne Details. Muss mit moderate.mjs
 * übereinstimmen (ein Test prüft das).
 */
export const CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  urheberrecht: 'Urheberrechtsverletzung gemeldet',
  schadsoftware: 'Schadsoftware',
  betrug: 'Betrug oder Phishing',
  persoenlichkeitsrecht: 'Verletzung von Persönlichkeitsrechten',
  gesetz: 'Verstoß gegen das Gesetz',
  missbrauch: 'Verstoß gegen das Gesetz',
  regeln: 'Verstoß gegen die Regeln'
})

/** Kategorie-Schlüssel → Text, sonst null. */
export function categoryText(key: unknown): string | null {
  const k = String(key ?? '').trim().toLowerCase()
  return Object.hasOwn(CATEGORIES, k) ? CATEGORIES[k] : null
}

export type ModErrorCode = 'badTarget' | 'badCategory' | 'serverError'
export interface ModError {
  ok: false
  code: ModErrorCode
  error: string
}

export interface LinkEntry {
  token: string
  reason: string | null
  blockedAt: number
}

export interface DeviceInfo {
  id: string
  online: boolean
  blocked: boolean
  reason: string | null
  blockedAt: number | null
  createdAt: number
  seenAt: number
}

const ERRORS: Record<ModErrorCode, string> = {
  badTarget: 'Das ist weder ein Relay-Link noch eine ID (18 Zeichen für einen Link, 8 für ein Gerät).',
  badCategory: `Unbekannte Kategorie. Möglich sind: ${Object.keys(CATEGORIES).join(', ')}`,
  serverError: 'Die Datenbank hat nicht geantwortet. Versuch es gleich noch einmal.'
}

const fail = (code: ModErrorCode): ModError => ({ ok: false, code, error: ERRORS[code] })

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v))
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Ziel für Antworten, ohne Zusatzfelder. */
function publicTarget(t: Target): Target {
  return t.kind === 'link' ? { kind: 'link', token: t.token, device: t.device } : { kind: 'device', device: t.device }
}

function linkRow(r: Record<string, unknown>): LinkEntry {
  return { token: String(r.token), reason: strOrNull(r.reason), blockedAt: num(r.created_at) }
}

export class Moderation {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Fängt jeden Fehler ab: Die Methoden werfen nie, auch nicht über RPC. */
  private async guard<T>(fn: () => Promise<T>): Promise<T | ModError> {
    try {
      return await fn()
    } catch {
      return fail('serverError')
    }
  }

  async categories(): Promise<{ ok: true; categories: { key: string; text: string }[] }> {
    return { ok: true, categories: Object.entries(CATEGORIES).map(([key, text]) => ({ key, text })) }
  }

  counts() {
    return this.guard(async () => {
      const r = await this.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM devices WHERE secret_hash <> '-') AS devices, " +
            "(SELECT COUNT(*) FROM devices WHERE secret_hash <> '-' AND online = 1) AS online, " +
            '(SELECT COUNT(*) FROM devices WHERE blocked = 1) AS blocked_devices, ' +
            '(SELECT COUNT(*) FROM blocked_links) AS blocked_links'
        )
        .first()
      return {
        ok: true as const,
        devices: num(r?.devices),
        online: num(r?.online),
        blockedDevices: num(r?.blocked_devices),
        blockedLinks: num(r?.blocked_links)
      }
    })
  }

  list() {
    return this.guard(async () => {
      const devices = await this.db
        .prepare('SELECT id, block_reason, blocked_at, seen_at FROM devices WHERE blocked = 1 ORDER BY id LIMIT ?1')
        .bind(LIST_LIMIT)
        .all()
      const links = await this.db
        .prepare('SELECT token, reason, created_at FROM blocked_links ORDER BY created_at DESC, token LIMIT ?1')
        .bind(LIST_LIMIT)
        .all()
      return {
        ok: true as const,
        devices: devices.results.map((r) => ({
          id: String(r.id),
          reason: strOrNull(r.block_reason),
          blockedAt: numOrNull(r.blocked_at),
          seenAt: num(r.seen_at)
        })),
        links: links.results.map(linkRow)
      }
    })
  }

  lookup(input: unknown) {
    const target = parseTarget(input)
    if (!target) return Promise.resolve(fail('badTarget'))
    return this.guard(async () => {
      // Bewusst ohne url und secret_hash.
      const d = await this.db
        .prepare(
          'SELECT id, online, blocked, block_reason, blocked_at, created_at, seen_at FROM devices WHERE id = ?1'
        )
        .bind(target.device)
        .first()
      const links =
        target.kind === 'link'
          ? await this.db
              .prepare('SELECT token, reason, created_at FROM blocked_links WHERE token = ?1')
              .bind(target.token)
              .all()
          : await this.db
              .prepare(
                'SELECT token, reason, created_at FROM blocked_links WHERE substr(token, 1, 8) = ?1 ' +
                  'ORDER BY created_at DESC, token LIMIT ?2'
              )
              .bind(target.device, LIST_LIMIT)
              .all()
      const device: DeviceInfo | null = d
        ? {
            id: String(d.id),
            online: num(d.online) === 1,
            blocked: num(d.blocked) === 1,
            reason: strOrNull(d.block_reason),
            blockedAt: numOrNull(d.blocked_at),
            createdAt: num(d.created_at),
            seenAt: num(d.seen_at)
          }
        : null
      return { ok: true as const, target: publicTarget(target), device, links: links.results.map(linkRow) }
    })
  }

  block(input: unknown, category: unknown) {
    const target = parseTarget(input)
    if (!target) return Promise.resolve(fail('badTarget'))
    const reason = categoryText(category)
    if (reason === null) return Promise.resolve(fail('badCategory'))
    return this.guard(async () => {
      const now = this.now()
      if (target.kind === 'link') {
        await this.db
          .prepare(
            'INSERT INTO blocked_links (token, reason, created_at) VALUES (?1, ?2, ?3) ' +
              'ON CONFLICT(token) DO UPDATE SET reason = excluded.reason'
          )
          .bind(target.token, reason, now)
          .run()
      } else {
        // Auch ein (noch) unbekanntes Gerät lässt sich sperren: Platzhalter mit ungültigem
        // Hash – eine spätere Anmeldung scheitert dann an der Sperre.
        await this.db
          .prepare(
            'INSERT INTO devices (id, secret_hash, url, online, created_at, seen_at, blocked, block_reason, blocked_at) ' +
              "VALUES (?1, '-', NULL, 0, ?2, ?2, 1, ?3, ?2) " +
              'ON CONFLICT(id) DO UPDATE SET blocked = 1, online = 0, block_reason = excluded.block_reason, ' +
              'blocked_at = excluded.blocked_at'
          )
          .bind(target.device, now, reason)
          .run()
      }
      return { ok: true as const, target: publicTarget(target), reason }
    })
  }

  unblock(input: unknown) {
    const target = parseTarget(input)
    if (!target) return Promise.resolve(fail('badTarget'))
    return this.guard(async () => {
      let changes: number
      if (target.kind === 'link') {
        const r = await this.db.prepare('DELETE FROM blocked_links WHERE token = ?1').bind(target.token).run()
        changes = num(r.meta.changes)
      } else {
        // Platzhalter löschen, echtes Gerät entsperren (sein Hash bleibt stehen).
        const rs = await this.db.batch([
          this.db.prepare("DELETE FROM devices WHERE id = ?1 AND secret_hash = '-'").bind(target.device),
          this.db
            .prepare(
              'UPDATE devices SET blocked = 0, block_reason = NULL, blocked_at = NULL WHERE id = ?1 AND blocked = 1'
            )
            .bind(target.device)
        ])
        changes = rs.reduce((n, r) => n + num(r.meta.changes), 0)
      }
      return { ok: true as const, target: publicTarget(target), changed: changes > 0 }
    })
  }
}
