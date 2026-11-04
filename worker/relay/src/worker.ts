// Foldwing-Relay: `main` für die Workers-Laufzeit (wrangler.toml).
//
// `default` ist der Relay selbst (index.ts). Dazu kommt der RPC-Einstieg `Admin` für die
// Moderation. Er hat keine Adresse im Internet: Erreichbar ist er nur für einen anderen
// Worker im selben Cloudflare-Konto, der ihn per Service Binding mit
// `entrypoint = "Admin"` einbindet. Eigene Datei, weil die Tests index.ts in Node laden
// und es `cloudflare:workers` dort nicht gibt.

import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Env } from './env'
import { Moderation } from './moderation'

export { default } from './index'

export class Admin extends WorkerEntrypoint<Env> {
  private mod(): Moderation {
    return new Moderation(this.env.DB)
  }

  categories() {
    return this.mod().categories()
  }

  counts() {
    return this.mod().counts()
  }

  list() {
    return this.mod().list()
  }

  lookup(input: unknown) {
    return this.mod().lookup(input)
  }

  block(input: unknown, category: unknown) {
    return this.mod().block(input, category)
  }

  unblock(input: unknown) {
    return this.mod().unblock(input)
  }
}
