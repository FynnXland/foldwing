import { useState } from 'react'
import type { LinkStatus } from '../types'
import { APP_NAME } from '../brand'
import { Icon } from './Icon'

interface Props {
  status: LinkStatus
  onOpenSettings: () => void
  /** Der Hinweis zum ersten Internet-Link wurde mit Esc weggeklickt: wieder öffnen. */
  onShowNotice: () => void
  noticeHidden: boolean
}

const DISMISS_KEY = 'foldwing.tunnelBanner.dismissed'

/**
 * Hinweisleiste zur Erreichbarkeit der Links (Relay und eigene Domain). Der
 * Info-Hinweis („App offen lassen“) lässt sich dauerhaft wegklicken. Bei einer
 * echten Störung erscheint die Leiste wieder, dann ist sie wichtig. Im Ruhezustand
 * und im eigenen Netz blendet App.tsx sie ganz aus.
 */
export function TunnelBanner({ status, onOpenSettings, onShowNotice, noticeHidden }: Props): JSX.Element | null {
  const [dismissedForever, setDismissedForever] = useState(() => {
    try {
      const ls = localStorage.getItem(DISMISS_KEY)
      if (ls === '1') return true
      if (ls === '0') return false
    } catch {
      /* localStorage gesperrt */
    }
    // localStorage verloren -> aus der robusten Config holen (Hinweis bleibt weg).
    try {
      return window.foldwing.getUiPrefs().bannerDismissed
    } catch {
      return false
    }
  })
  const [errorHidden, setErrorHidden] = useState(false)

  const problem = status.state === 'offline' || status.state === 'error' || status.state === 'blocked'

  // Ruhe und Verbinden zeigt schon die Statuszeile über der Ablage (Punkt + „verbindet …“);
  // eine zweite Leiste mit demselben Punkt wäre doppelt.
  if (status.state === 'resting' || status.state === 'connecting') return null
  // Den wartenden Zustand erklärt der Dialog; nur wenn er weggeklickt ist, hier erinnern.
  if (status.state === 'waiting') {
    if (!noticeHidden) return null
    return (
      <div className="banner banner--info" role="status">
        <span className="dot dot--busy" aria-hidden />
        <span className="banner__text">
          Dein Internet-Link wartet noch. Bestätige kurz den Hinweis, dann geht er los.
        </span>
        <button className="btn btn--primary btn--sm" onClick={onShowNotice}>
          Hinweis ansehen
        </button>
      </div>
    )
  }
  if (problem ? errorHidden : dismissedForever) return null

  const dismiss = (): void => {
    if (problem) {
      setErrorHidden(true) // Störungshinweis nur für diese Sitzung ausblenden
      return
    }
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* egal, die Config hält es auch */
    }
    try {
      window.foldwing.setUiPrefs({ bannerDismissed: true })
    } catch {
      /* Bridge nicht da */
    }
    setDismissedForever(true)
  }

  return (
    <div className={`banner ${problem ? 'banner--problem' : 'banner--info'}`} role={problem ? 'alert' : 'status'}>
      <span className={`dot ${problem ? 'dot--problem' : 'dot--ok'}`} aria-hidden />
      <span className="banner__text">
        {problem ? (
          status.text
        ) : (
          <>
            Deine Links funktionieren, solange {APP_NAME} läuft. Beendest du die App, sind sie nicht
            mehr erreichbar.
          </>
        )}
      </span>
      {problem && (
        <button className="btn btn--sm" onClick={onOpenSettings}>
          Zu den Einstellungen
        </button>
      )}
      <button
        className="icon-btn"
        title={problem ? 'Für jetzt ausblenden' : 'Nicht mehr zeigen'}
        aria-label={problem ? 'Für jetzt ausblenden' : 'Nicht mehr zeigen'}
        onClick={dismiss}
      >
        <Icon name="x" size={15} />
      </button>
    </div>
  )
}
