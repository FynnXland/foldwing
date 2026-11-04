// Foldwing-Relay: Einstieg für die Workers-Laufzeit.
// Aufbau und Datenschutz-Fakten: worker/relay/README.md.

import { createWorker } from './router'

export { createWorker } from './router'
export type { Store, Lookup, DeviceRecord } from './store'
export { D1Store } from './store'

export default createWorker()
