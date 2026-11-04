// Speicher-Schicht. Der Rest des Workers kennt nur die Schnittstelle `Store`; die
// D1-Umsetzung steht hier, Tests setzen ihre eigene ein. Gespeichert wird nur, was
// die SPEC nennt: Gerät, Hash des Secrets, aktuelle Tunnel-Adresse, Zeiten, Sperren
// (dazu der Zeitpunkt einer Geräte-Sperre für die 451-Seite).
// Keine IP-Adressen, keine Besucherdaten.

import type { D1Database } from './env'

export interface DeviceRecord {
  id: string
  secretHash: string
  url: string | null
  online: boolean
  blocked: boolean
}

/** Grund und Zeitpunkt einer Sperre, wie sie die 451-Seite zeigt. */
export interface BlockInfo {
  reason: string | null
  at: number | null
}

/** Was ein Besucher-Aufruf über Gerät und Link wissen muss – eine Abfrage. */
export interface Lookup {
  /** null = Gerät unbekannt */
  device: { url: string | null; online: boolean; blocked: boolean } | null
  linkBlocked: boolean
  /** gesetzt, wenn Link oder Gerät gesperrt ist (die Link-Sperre geht vor) */
  block?: BlockInfo | null
}

export interface Store {
  lookup(deviceId: string, token: string): Promise<Lookup>
  getDevice(deviceId: string): Promise<DeviceRecord | null>
  /**
   * Gerät anlegen oder Adresse auffrischen – atomar und nur, wenn der Hash passt
   * und das Gerät nicht gesperrt ist. false = nichts geändert (vergeben/gesperrt).
   */
  upsertDevice(deviceId: string, secretHash: string, url: string, now: number): Promise<boolean>
  /** online = 0, nur mit passendem Hash. */
  setOffline(deviceId: string, secretHash: string): Promise<void>
  /** Nicht gesperrte Geräte löschen, die vor `cutoff` zuletzt gesehen wurden. */
  deleteStale(cutoff: number): Promise<number>
}

interface LookupRow {
  url: string | null
  online: number | null
  blocked: number | null
  found: number | null
  block_reason: string | null
  blocked_at: number | null
  link_blocked: number
  link_reason: string | null
  link_at: number | null
}

interface DeviceRow {
  id: string
  secret_hash: string
  url: string | null
  online: number
  blocked: number
}

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async lookup(deviceId: string, token: string): Promise<Lookup> {
    // (SELECT 1) als Anker: Es kommt immer genau eine Zeile zurück, auch für ein
    // unbekanntes Gerät – so reicht eine Abfrage für Gerät und Link-Sperre.
    const row = await this.db
      .prepare(
        `SELECT d.url AS url, d.online AS online, d.blocked AS blocked, d.id IS NOT NULL AS found,
                d.block_reason AS block_reason, d.blocked_at AS blocked_at,
                b.token IS NOT NULL AS link_blocked, b.reason AS link_reason, b.created_at AS link_at
           FROM (SELECT 1) AS anchor
           LEFT JOIN devices AS d ON d.id = ?1
           LEFT JOIN blocked_links AS b ON b.token = ?2`
      )
      .bind(deviceId, token)
      .first<LookupRow>()
    if (!row) return { device: null, linkBlocked: false, block: null }
    const linkBlocked = row.link_blocked === 1
    const deviceBlocked = row.blocked === 1
    return {
      device: row.found ? { url: row.url ?? null, online: row.online === 1, blocked: deviceBlocked } : null,
      linkBlocked,
      block: linkBlocked
        ? { reason: row.link_reason ?? null, at: row.link_at ?? null }
        : deviceBlocked
          ? { reason: row.block_reason ?? null, at: row.blocked_at ?? null }
          : null
    }
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | null> {
    const row = await this.db
      .prepare('SELECT id, secret_hash, url, online, blocked FROM devices WHERE id = ?1')
      .bind(deviceId)
      .first<DeviceRow>()
    if (!row) return null
    return {
      id: row.id,
      secretHash: row.secret_hash,
      url: row.url ?? null,
      online: row.online === 1,
      blocked: row.blocked === 1
    }
  }

  async upsertDevice(deviceId: string, secretHash: string, url: string, now: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO devices (id, secret_hash, url, online, created_at, seen_at, blocked)
              VALUES (?1, ?2, ?3, 1, ?4, ?4, 0)
         ON CONFLICT(id) DO UPDATE SET url = excluded.url, online = 1, seen_at = excluded.seen_at
              WHERE devices.secret_hash = excluded.secret_hash AND devices.blocked = 0`
      )
      .bind(deviceId, secretHash, url, now)
      .run()
    return (res.meta.changes ?? 0) > 0
  }

  async setOffline(deviceId: string, secretHash: string): Promise<void> {
    await this.db
      .prepare('UPDATE devices SET online = 0 WHERE id = ?1 AND secret_hash = ?2')
      .bind(deviceId, secretHash)
      .run()
  }

  async deleteStale(cutoff: number): Promise<number> {
    const res = await this.db
      .prepare('DELETE FROM devices WHERE seen_at < ?1 AND blocked = 0')
      .bind(cutoff)
      .run()
    return res.meta.changes ?? 0
  }
}

/**
 * Kurzer Zwischenspeicher je Isolate für Besucher-Abfragen, damit nicht jede
 * Range-Anfrage eines Videos D1 trifft. Gilt höchstens `ttlMs` (≤ 30 s); der Aufrufer kann
 * einzelne Einträge kürzer halten (z. B. „offline“). Größe gedeckelt.
 */
export class LookupCache {
  private readonly map = new Map<string, { until: number; value: Lookup }>()

  constructor(
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 5_000
  ) {}

  get(token: string, now: number): Lookup | undefined {
    const hit = this.map.get(token)
    if (!hit) return undefined
    if (hit.until <= now) {
      this.map.delete(token)
      return undefined
    }
    return hit.value
  }

  set(token: string, value: Lookup, now: number, ttlMs = this.ttlMs): void {
    this.map.delete(token)
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
    this.map.set(token, { until: now + Math.min(ttlMs, this.ttlMs, 30_000), value })
  }

  delete(token: string): void {
    this.map.delete(token)
  }

  /** Alle Einträge eines Geräts vergessen (nach An- oder Abmeldung in diesem Isolate). */
  forgetDevice(deviceId: string): void {
    for (const key of [...this.map.keys()]) if (key.startsWith(deviceId)) this.map.delete(key)
  }
}
