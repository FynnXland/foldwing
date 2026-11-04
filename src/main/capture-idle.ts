/**
 * Leerlauf-Freigabe der Screenshot-Aufnahme: Nach einer Aufnahme bleiben Overlays
 * und Fenster-Helfer noch eine Weile bereit (Serienaufnahmen), danach gibt
 * `release` sie frei – im Leerlauf soll die Aufnahme keinen Speicher belegen.
 * Rein und electron-frei, damit testbar (tests/capture-idle.test.ts).
 */
export interface IdleRelease {
  /** Aufnahme vorbei: Zeitgeber (neu) starten. Meldet `inUse` noch Betrieb, passiert nichts. */
  arm(): void
  /** Neue Aufnahme bzw. Aktionsleiste offen: Zeitgeber anhalten. */
  cancel(): void
  /** Läuft gerade ein Zeitgeber? */
  pending(): boolean
}

export function createIdleRelease(opts: {
  delayMs: number
  /** Wird gerade etwas gebraucht (Aufnahme läuft, Aktionsleiste offen)? Dann nicht freigeben. */
  inUse: () => boolean
  release: () => void
}): IdleRelease {
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return {
    arm(): void {
      cancel()
      if (opts.inUse()) return
      timer = setTimeout(() => {
        timer = null
        // Sicherheitsnetz: Ist inzwischen doch wieder etwas in Betrieb, nicht abräumen –
        // dessen Ende startet den Zeitgeber ohnehin neu.
        if (!opts.inUse()) opts.release()
      }, opts.delayMs)
    },
    cancel,
    pending: () => timer !== null
  }
}
