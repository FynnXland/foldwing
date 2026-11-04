import type { UpdateStatus } from '../types'
import { APP_NAME } from '../brand'

interface Props {
  status: UpdateStatus | null
  releasesUrl: string
  onInstall: () => void
}

/**
 * Leiste, sobald ein Update heruntergeladen und startklar ist. Ein Klick startet
 * die App neu und installiert. Während des Ladens ein ruhiger Hinweis.
 * Portable und .deb bekommen nur den Hinweis mit Link auf die Releases-Seite.
 */
export function UpdateBanner({ status, releasesUrl, onInstall }: Props): JSX.Element | null {
  if (!status) return null

  if (status.state === 'downloaded') {
    return (
      <div className="banner banner--info" role="status">
        <span className="banner__text">
          <strong>Version {status.version} ist bereit.</strong> Sie wird beim Beenden installiert,
          oder gleich jetzt.
        </span>
        <button className="btn btn--primary btn--sm" onClick={onInstall}>
          Neu starten und installieren
        </button>
      </div>
    )
  }

  if (status.state === 'manual') {
    return (
      <div className="banner banner--info" role="status">
        <span className="banner__text">
          <strong>
            {APP_NAME} {status.version} ist da.
          </strong>{' '}
          Diese Version aktualisiert sich nicht selbst.
        </span>
        {releasesUrl && (
          <button className="btn btn--primary btn--sm" onClick={() => window.foldwing.openExternal(releasesUrl)}>
            Zum Download
          </button>
        )}
      </div>
    )
  }

  if (status.state === 'downloading' || status.state === 'available') {
    const pct = status.state === 'downloading' ? ` (${status.percent} %)` : ''
    return (
      <div className="banner" role="status">
        <span className="banner__text">Ein Update wird geladen{pct}.</span>
      </div>
    )
  }

  return null
}
