// Anmeldung und Abmeldung der Apps: POST /_/api/register und /_/api/unregister.
// Antworten sind knappe JSON-Codes; die App entscheidet daraus selbst, was sie tut
// (409 → neue Geräte-ID, 422 → später noch mal, 403 → gesperrt).

import type { Env, FetchLike } from './env'
import { DEVICE_ID, SECRET, VERSION, isTunnelUrl } from './ids'
import { BodyTooLarge, apiError, json, readLimited } from './http'
import { constantTimeEqual, networkKey, overLimit, sha256hex } from './security'
import type { LookupCache, Store } from './store'

/** Höchstgröße des JSON-Körpers. */
export const MAX_BODY = 2048
/** Zeit für den Gesundheits-Check des Tunnels. */
export const HEALTH_TIMEOUT_MS = 8_000
/** Höchstgröße der Antwort von /api/health. */
const MAX_HEALTH_BYTES = 1024

export interface ApiDeps {
  env: Env
  store: Store
  cache: LookupCache
  fetch: FetchLike
  now: () => number
}

type Parsed =
  | { ok: true; id: string; secret: string; url?: string }
  | { ok: false; response: Response }

async function parseBody(request: Request, needUrl: boolean): Promise<Parsed> {
  let text: string
  try {
    text = await readLimited(request, MAX_BODY)
  } catch (e) {
    if (e instanceof BodyTooLarge) return { ok: false, response: apiError('too_large', 413) }
    return { ok: false, response: apiError('bad_request', 400) }
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, response: apiError('bad_request', 400) }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, response: apiError('bad_request', 400) }
  }
  const b = body as Record<string, unknown>
  const id = b.id
  const secret = b.secret
  if (typeof id !== 'string' || !DEVICE_ID.test(id) || typeof secret !== 'string' || !SECRET.test(secret)) {
    return { ok: false, response: apiError('bad_request', 400) }
  }
  if (b.version !== undefined && (typeof b.version !== 'string' || !VERSION.test(b.version))) {
    return { ok: false, response: apiError('bad_request', 400) }
  }
  if (!needUrl) return { ok: true, id, secret }
  if (!isTunnelUrl(b.url)) return { ok: false, response: apiError('bad_request', 400) }
  return { ok: true, id, secret, url: b.url }
}

/**
 * Antwortet der Tunnel als genau dieses Foldwing-Gerät? Schützt davor, dass
 * jemand eine fremde Tunnel-Adresse unter seiner eigenen Geräte-ID einträgt.
 */
export async function healthMatches(fetchFn: FetchLike, url: string, id: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const res = await fetchFn(url + '/api/health', {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'Foldwing-Relay' },
      redirect: 'manual',
      signal: controller.signal,
      cache: 'no-store'
    })
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => undefined)
      return false
    }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_HEALTH_BYTES) {
        await reader.cancel().catch(() => undefined)
        return false
      }
      chunks.push(value)
    }
    const all = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      all.set(c, off)
      off += c.byteLength
    }
    const data = JSON.parse(new TextDecoder().decode(all)) as Record<string, unknown> | null
    return !!data && data.app === 'Foldwing' && data.device === id
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function handleRegister(request: Request, deps: ApiDeps): Promise<Response> {
  const parsed = await parseBody(request, true)
  if (!parsed.ok) return parsed.response
  const { id, secret } = parsed
  const url = parsed.url as string

  if (await overLimit(deps.env.REGISTER_LIMITER, [`dev:${id}`, `net:${await networkKey(request)}`])) {
    return apiError('rate_limited', 429, { 'Retry-After': '60' })
  }

  const hash = await sha256hex(secret)
  const existing = await deps.store.getDevice(id)
  if (existing?.blocked) return apiError('blocked', 403)
  // Das Secret wird VOR dem Gesundheits-Check verglichen: Wer die ID eines anderen
  // Geräts übernehmen will, löst so nicht einmal eine Abfrage an seinen Tunnel aus.
  if (existing && !constantTimeEqual(existing.secretHash, hash)) return apiError('taken', 409)

  if (!(await healthMatches(deps.fetch, url, id))) return apiError('unreachable', 422)

  const changed = await deps.store.upsertDevice(id, hash, url, deps.now())
  if (!changed) {
    // Zwischen Prüfung und Schreiben hat sich etwas geändert (gleichzeitige
    // Anmeldung oder Sperre) – sauber unterscheiden.
    const current = await deps.store.getDevice(id)
    return current?.blocked ? apiError('blocked', 403) : apiError('taken', 409)
  }
  deps.cache.forgetDevice(id)
  return json({ ok: true })
}

export async function handleUnregister(request: Request, deps: ApiDeps): Promise<Response> {
  const parsed = await parseBody(request, false)
  if (!parsed.ok) return parsed.response
  const { id, secret } = parsed

  if (await overLimit(deps.env.REGISTER_LIMITER, [`dev:${id}`, `net:${await networkKey(request)}`])) {
    return apiError('rate_limited', 429, { 'Retry-After': '60' })
  }

  const existing = await deps.store.getDevice(id)
  if (!existing) return json({ ok: true })
  const hash = await sha256hex(secret)
  if (!constantTimeEqual(existing.secretHash, hash)) return apiError('taken', 409)
  await deps.store.setOffline(id, hash)
  deps.cache.forgetDevice(id)
  return json({ ok: true })
}
