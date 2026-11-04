// Routing des Relay-Workers. Alle Pfade sind feste Muster; was nicht passt, ist 404.
//
// Seiten (`/<T>`, `/<T>/<F>`) und Schriften reicht der Worker gestreamt durch.
// Rohdaten (`/<T>/d`, `/<T>/<F>/d`) beantwortet er mit 302 auf denselben Pfad beim
// Tunnel: Dateiinhalte fließen so nie durch den Worker (reine Vermittlung).

import type { Env, ExecutionContext, FetchLike, ScheduledController } from './env'
import { isTunnelUrl, parseRelayPath, tokenFromInput, type RelayPath } from './ids'
import { apiError, html, plain, redirect } from './http'
import {
  badGatewayPage,
  blockedPage,
  infoPage,
  methodPage,
  notFoundPage,
  offlinePage,
  operatorFrom,
  reportPage,
  tooManyPage,
  unavailablePage,
  type PageCtx
} from './pages'
import { fetchOrigin, shapeResponse } from './proxy'
import { handleRegister, handleUnregister, type ApiDeps } from './register'
import { networkKey, overLimit } from './security'
import { D1Store, LookupCache, type Lookup, type Store } from './store'

/** Geräte, die sich so lange nicht gemeldet haben, löscht der tägliche Cron. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
/** „Offline“ und „unbekannt“ nur kurz merken – ein frisch angemeldetes Gerät soll schnell erreichbar sein. */
const NEGATIVE_TTL_MS = 5_000

export interface WorkerOptions {
  /** Speicher-Schicht; Standard: D1 aus `env.DB`. */
  store?: (env: Env) => Store
  /** fetch für Tunnel-Abfragen (Tests setzen hier ein Mock ein). */
  fetch?: FetchLike
  now?: () => number
  /** Lebensdauer des Zwischenspeichers, höchstens 30 s. */
  cacheTtlMs?: number
  /** Wartezeit auf die Antwort-Header des Tunnels. */
  originTimeoutMs?: number
}

export interface RelayWorker {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response>
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>
}

const READ_ONLY = { Allow: 'GET, HEAD' }

export function createWorker(opts: WorkerOptions = {}): RelayWorker {
  const cache = new LookupCache(opts.cacheTtlMs ?? 30_000)
  const fetchFn: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init as RequestInit))
  const now = opts.now ?? (() => Date.now())
  const makeStore = opts.store ?? ((env: Env) => new D1Store(env.DB))

  async function lookup(store: Store, rp: RelayPath, fresh: boolean): Promise<{ info: Lookup; cached: boolean }> {
    const t = now()
    if (!fresh) {
      const hit = cache.get(rp.token, t)
      if (hit) return { info: hit, cached: true }
    }
    const info = await store.lookup(rp.device, rp.token)
    const reachable = !!info.device && info.device.online && !info.device.blocked && !info.linkBlocked
    cache.set(rp.token, info, t, reachable || isBlocked(info) ? undefined : NEGATIVE_TTL_MS)
    return { info, cached: false }
  }

  const isBlocked = (info: Lookup) => info.linkBlocked || !!info.device?.blocked

  /** Tunnel-Adresse, wenn das Gerät online ist und die Adresse stimmt – sonst null. */
  function originOf(info: Lookup): string | null {
    const url = info.device?.online ? info.device.url : null
    // Auch beim Lesen noch einmal prüfen: Was in der Datenbank steht, ist nie ein
    // Freibrief für ein beliebiges Ziel.
    return url && isTunnelUrl(url) ? url : null
  }

  async function visit(request: Request, url: URL, rp: RelayPath, env: Env, ctx: PageCtx): Promise<Response> {
    // Volumenbremse: je Netz, und für Seiten und Dateien zusätzlich je Gerät und je
    // Link. Ohne Bindings läuft alles weiter.
    const limited =
      (await overLimit(env.PROXY_LIMITER, [`v:${await networkKey(request)}`])) ||
      (rp.kind !== 'font' &&
        ((await overLimit(env.DEVICE_LIMITER, [`d:${rp.device}`])) ||
          (await overLimit(env.LINK_LIMITER, [`l:${rp.token}`]))))
    if (limited) return html(request, tooManyPage(ctx), 429, { 'Retry-After': '30' })

    const store = makeStore(env)
    let { info, cached } = await lookup(store, rp, false)
    if (isBlocked(info)) return html(request, blockedPage(ctx, rp.token, info.block), 451)

    if (rp.kind === 'raw') {
      const origin = originOf(info)
      if (!origin) return html(request, offlinePage(ctx, rp.token), 503, { 'Retry-After': '60' })
      // Pfad und Query sind geprüft bzw. gehen unverändert mit; das Ziel ist immer
      // genau der Tunnel dieses Geräts.
      return redirect(origin + rp.path + url.search)
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (isBlocked(info)) return html(request, blockedPage(ctx, rp.token, info.block), 451)
      const origin = originOf(info)
      if (origin) {
        const upstream = await fetchOrigin(fetchFn, origin, rp, request, url.search, opts.originTimeoutMs)
        if (upstream) {
          const verdict = shapeResponse(request, rp, upstream)
          if ('ok' in verdict) return verdict.ok
          if ('bad' in verdict) return html(request, badGatewayPage(ctx, rp.token), 502)
        }
      }
      // Nicht erreichbar. Kam die Adresse aus dem Zwischenspeicher, kann sie veraltet
      // sein (App neu gestartet, neue Tunnel-Adresse) – einmal frisch fragen. Ein
      // gemerktes „offline“ gilt dagegen für seine paar Sekunden.
      if (!cached || !origin) break
      ;({ info, cached } = await lookup(store, rp, true))
      if (!isBlocked(info) && originOf(info) === origin) break
    }
    if (isBlocked(info)) return html(request, blockedPage(ctx, rp.token, info.block), 451)
    return html(request, offlinePage(ctx, rp.token), 503, { 'Retry-After': '60' })
  }

  async function route(request: Request, env: Env, ctx: PageCtx): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method
    const isRead = method === 'GET' || method === 'HEAD'

    if (path === '/_/api/register' || path === '/_/api/unregister') {
      if (method !== 'POST') return apiError('method_not_allowed', 405, { Allow: 'POST' })
      const deps: ApiDeps = { env, store: makeStore(env), cache, fetch: fetchFn, now }
      return path === '/_/api/register' ? handleRegister(request, deps) : handleUnregister(request, deps)
    }
    if (path.startsWith('/_/api/')) return apiError('not_found', 404)

    const rp = parseRelayPath(path)
    if (!isRead) return html(request, methodPage(ctx), 405, READ_ONLY)
    if (rp) return visit(request, url, rp, env, ctx)

    switch (path) {
      case '/':
        return redirect('/_/')
      case '/_/':
        return html(request, infoPage(ctx))
      case '/_/melden':
        return html(request, reportPage(ctx, tokenFromInput(url.searchParams.get('l'))))
      // Kurzwege für die Fußzeile der App-Seiten; Ziele nur aus den Variablen.
      case '/_/impressum':
        return ctx.op.imprint ? redirect(ctx.op.imprint) : html(request, notFoundPage(ctx), 404)
      case '/_/datenschutz':
        return ctx.op.privacy ? redirect(ctx.op.privacy) : html(request, notFoundPage(ctx), 404)
      case '/_/regeln':
        return ctx.op.terms ? redirect(ctx.op.terms) : html(request, notFoundPage(ctx), 404)
      case '/robots.txt':
        return plain(request, 'User-agent: *\nDisallow: /\n')
      default:
        return html(request, notFoundPage(ctx), 404)
    }
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url)
      const ctx: PageCtx = { op: operatorFrom(env), host: url.hostname, origin: url.origin }
      try {
        return await route(request, env, ctx)
      } catch {
        // Kein Stacktrace nach außen, keine Logs (Observability ist aus).
        if (url.pathname.startsWith('/_/api/')) return apiError('unavailable', 503)
        return html(request, unavailablePage(ctx), 503, { 'Retry-After': '60' })
      }
    },

    async scheduled(_controller, env, ctx) {
      ctx.waitUntil(
        makeStore(env)
          .deleteStale(now() - STALE_AFTER_MS)
          .catch(() => 0)
      )
    }
  }
}
