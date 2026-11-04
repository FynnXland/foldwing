import { useEffect, useRef, useState } from 'react'

interface Props {
  rulesUrl: string
  privacyUrl: string
  onAccept: () => Promise<void> | void
  onLanOnly: () => Promise<void> | void
  /** Esc: Dialog schließen, ohne zu entscheiden. Der Link wartet weiter. */
  onLater: () => void
}

/**
 * Hinweis vor der ersten Anmeldung beim Relay. Erst „Okay, Link erstellen“ lässt
 * die App sich anmelden; bis dahin wartet der Link. Kein Häkchen, kein
 * Kleingedrucktes. Der Text ist rechtlich abgestimmt
 * (privat/recht/texte-fuer-app-und-worker.md, Abschnitt 3) und bleibt wörtlich.
 */
export function RelayNotice({ rulesUrl, privacyUrl, onAccept, onLanOnly, onLater }: Props): JSX.Element {
  const [busy, setBusy] = useState(false)
  const okRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // Fokus auf den Dialog selbst, nicht auf „Okay“: Holt sich das Fenster den Fokus
  // mitten im Tippen, darf ein Enter den Hinweis nicht versehentlich bestätigen.
  useEffect(() => boxRef.current?.focus(), [])

  // Esc schließt; Tab bleibt im Dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onLater()
        return
      }
      if (e.key !== 'Tab' || !boxRef.current) return
      const items = [...boxRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onLater])

  const run = (fn: () => Promise<void> | void) => async (): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const open = (url: string) => (e: React.MouseEvent): void => {
    e.preventDefault()
    void window.foldwing.openExternal(url)
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={boxRef}
        className="modal"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="relay-notice-title"
        aria-describedby="relay-notice-text"
      >
        <h2 id="relay-notice-title" className="modal__title">
          Dein erster Internet-Link
        </h2>
        <p id="relay-notice-text" className="modal__text">
          Damit der Link aus dem Internet funktioniert, läuft er über share.fynn.land. Deine Dateien
          bleiben auf deinem Rechner; der Relay reicht sie nur durch und speichert nichts. Teile
          bitte nur, was du teilen darfst; rechtswidrige Links sperre ich.
        </p>
        <p className="modal__links">
          <a className="textlink" href={rulesUrl} onClick={open(rulesUrl)}>
            Regeln
          </a>
          {' · '}
          <a className="textlink" href={privacyUrl} onClick={open(privacyUrl)}>
            Datenschutz
          </a>
        </p>
        <div className="modal__actions">
          <button className="btn" onClick={run(onLanOnly)} disabled={busy}>
            Nur im eigenen Netzwerk teilen
          </button>
          <button ref={okRef} className="btn btn--primary" onClick={run(onAccept)} disabled={busy}>
            Okay, Link erstellen
          </button>
        </div>
      </div>
    </div>
  )
}
