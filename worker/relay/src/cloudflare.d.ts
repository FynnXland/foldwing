// Kleiner Ausschnitt aus `cloudflare:workers`, nur was worker.ts braucht (siehe env.ts:
// bewusst ohne @cloudflare/workers-types).

declare module 'cloudflare:workers' {
  export abstract class WorkerEntrypoint<E = unknown> {
    protected readonly ctx: { waitUntil(promise: Promise<unknown>): void }
    protected readonly env: E
    constructor(ctx: unknown, env: E)
  }
}
