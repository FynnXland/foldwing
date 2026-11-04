// Minimale Typen für die Cloudflare-Laufzeit. Bewusst selbst geschrieben statt
// @cloudflare/workers-types: Das Repo soll dafür keine neue Abhängigkeit bekommen,
// und der Worker braucht nur einen kleinen Ausschnitt.

export interface D1Result {
  success: boolean
  meta: { changes?: number; [key: string]: unknown }
  results?: unknown[]
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<D1Result>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  /** Mehrere Anweisungen in einer Transaktion (alle oder keine). */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>
}

/** Workers-Rate-Limiting-Binding (`[[ratelimits]]` in der wrangler.toml). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

export interface ScheduledController {
  scheduledTime: number
  cron: string
}

export interface Env {
  DB: D1Database
  /** Optional: begrenzt Anmeldungen (je Gerät und je Netz). */
  REGISTER_LIMITER?: RateLimiter
  /** Optional: begrenzt Besucher-Anfragen je Netz, schützt die Rechner der Teilenden. */
  PROXY_LIMITER?: RateLimiter
  /** Optional: Volumenbremse je Gerät (alle Links eines Rechners zusammen). */
  DEVICE_LIMITER?: RateLimiter
  /** Optional: Volumenbremse je Link. */
  LINK_LIMITER?: RateLimiter
  /** Betreiber-Angaben – kommen nie aus dem Code, nur aus der wrangler.toml. */
  CONTACT_EMAIL?: string
  IMPRINT_URL?: string
  PRIVACY_URL?: string
  TERMS_URL?: string
  /** Optional: Link auf den Quellcode, z. B. das GitHub-Repository. */
  SOURCE_URL?: string
}

/** Streaming-HTML-Umbau der Workers-Laufzeit (nur das, was wir nutzen). */
export interface HtmlElement {
  getAttribute(name: string): string | null
  remove(): void
}

export interface HtmlRewriterLike {
  on(selector: string, handlers: { element(el: HtmlElement): void }): HtmlRewriterLike
  transform(response: Response): Response
}

/** Erweiterte fetch-Optionen der Workers-Laufzeit. */
export type WorkerRequestInit = RequestInit & { cf?: Record<string, unknown> }

export type FetchLike = (input: string, init?: WorkerRequestInit) => Promise<Response>
