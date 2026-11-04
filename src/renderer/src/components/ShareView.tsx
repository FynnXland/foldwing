import { useEffect, useMemo, useState } from 'react'
import type { LinksInfo, LinkStatus, ServerInfo, ShareItem } from '../types'
import { ShareCard } from './ShareCard'
import { Dropzone } from './Dropzone'
import { Icon } from './Icon'

interface Props {
  items: ShareItem[]
  server: ServerInfo | null
  links: LinksInfo | null
  linkStatus: LinkStatus | null
  onUpload: (files: FileList | File[]) => void
  onDelete: (item: ShareItem) => void
  onSetExpiry: (item: ShareItem, expiresAt: number | null) => void
  onOpenSettings: () => void
}

const PREVIEW_KEY = 'foldwing.previews'
/** Ab so vielen Freigaben lohnt sich das Suchfeld. */
const SEARCH_FROM = 4

/** Punkt-Farbe je Zustand der Links. */
export function dotClass(s: LinkStatus | null): string {
  switch (s?.state) {
    case 'online':
      return 'dot--ok'
    case 'connecting':
    case 'waiting':
      return 'dot--busy'
    case 'offline':
    case 'error':
    case 'blocked':
      return 'dot--problem'
    default:
      return ''
  }
}

/** Zustand der Links in zwei, drei Worten für die Zeile über der Ablage. */
function shortState(s: LinkStatus): string {
  switch (s.state) {
    case 'online':
      return 'erreichbar'
    case 'connecting':
      return 'verbindet …'
    case 'waiting':
      return 'wartet auf dich'
    case 'resting':
      return 'ruht, bis du etwas teilst'
    case 'offline':
      return 'gerade nicht erreichbar'
    case 'blocked':
      return 'gesperrt'
    default:
      return 'Störung, Näheres in den Einstellungen'
  }
}

const host = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

/** Wo die Links gerade hinführen, in Worten. */
function whereText(links: LinksInfo | null, server: ServerInfo | null): { where: string; addr?: string } {
  const mode = links?.mode ?? server?.linkMode ?? 'relay'
  if (mode === 'lan') {
    return { where: 'Links nur im eigenen Netzwerk', addr: server?.effectiveBaseUrl ? host(server.effectiveBaseUrl) : undefined }
  }
  if (mode === 'domain') {
    return { where: `Links über ${links?.publicBaseUrl ? host(links.publicBaseUrl) : 'deine Domain'}` }
  }
  return { where: `Links über ${links?.relayBase ? host(links.relayBase) : 'das Internet'}` }
}

/** Teilen-Ansicht: Einstieg (nur solange nichts geteilt ist), Ablage, Liste. */
export function ShareView({
  items,
  server,
  links,
  linkStatus,
  onUpload,
  onDelete,
  onSetExpiry,
  onOpenSettings
}: Props): JSX.Element {
  const [query, setQuery] = useState('')
  // Bild-/Video-Vorschau in den Karten, abschaltbar; die Wahl bleibt gespeichert.
  const [showPreviews, setShowPreviews] = useState(() => {
    try {
      const ls = localStorage.getItem(PREVIEW_KEY)
      if (ls === '0') return false
      if (ls === '1') return true
    } catch {
      /* localStorage gesperrt */
    }
    // localStorage verloren -> aus der robusten Config holen.
    try {
      return window.foldwing.getUiPrefs().previews
    } catch {
      return true
    }
  })
  const togglePreviews = (): void => {
    setShowPreviews((v) => {
      const next = !v
      try {
        localStorage.setItem(PREVIEW_KEY, next ? '1' : '0')
      } catch {
        /* egal, die Config hält es auch */
      }
      try {
        window.foldwing.setUiPrefs({ previews: next })
      } catch {
        /* Bridge nicht da */
      }
      return next
    })
  }
  // Minuten-Takt, damit Restlaufzeiten („in 23 Std.“) aktuell bleiben.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(iv)
  }, [])

  const hasItems = items.length > 0
  const hasMedia = items.some(
    (i) => i.previewUrl || (i.files ?? []).some((f) => f.previewUrl)
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Sucht auch in den Dateinamen innerhalb einer Sammlung.
    const list = q
      ? items.filter(
          (it) =>
            it.name.toLowerCase().includes(q) ||
            (it.files ?? []).some((f) => f.name.toLowerCase().includes(q))
        )
      : items
    return list.slice().reverse()
  }, [items, query])

  const { where, addr } = whereText(links, server)

  return (
    <>
      {!hasItems && (
        <div className="intro">
          <h1>Dateien teilen, die bei dir bleiben</h1>
          <p>
            Leg eine Datei ab und du bekommst einen Link. Wer ihn öffnet, lädt die Datei direkt von
            deinem Rechner, im Original und ohne Umweg über eine fremde Cloud.
          </p>
        </div>
      )}

      <p className="linkline" role="status">
        <span className={`dot ${dotClass(linkStatus)}`} aria-hidden />
        <span className="linkline__where">{where}</span>
        {addr && <span className="linkline__addr">{addr}</span>}
        {/* Kurz gefasst; den ganzen Satz zeigen Leiste und Einstellungen. */}
        {linkStatus && <span>· {shortState(linkStatus)}</span>}
        <button className="textlink" onClick={onOpenSettings}>
          Ändern
        </button>
      </p>

      <Dropzone onUpload={onUpload} compact={hasItems} />

      {!hasItems ? (
        <p className="empty-note">
          Hier erscheinen deine Links. Jeder lässt sich kopieren, im Browser öffnen und mit einer
          Ablaufzeit versehen. Sie funktionieren, solange die App läuft.
        </p>
      ) : (
        <>
          <div className="list-head">
            <h2>
              Deine Freigaben<span className="list-head__count">{items.length}</span>
            </h2>
            {hasMedia && (
              <button className="toggle-btn" onClick={togglePreviews} aria-pressed={showPreviews}>
                <Icon name={showPreviews ? 'eye' : 'eye-off'} size={15} />
                Vorschaubilder
              </button>
            )}
            {items.length >= SEARCH_FROM && (
              <input
                className="input"
                type="search"
                placeholder="Suchen"
                aria-label="Freigaben durchsuchen"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
          </div>

          {visible.length === 0 ? (
            <p className="no-match">Keine Freigabe passt zu „{query}“.</p>
          ) : (
            <div className="share-list">
              {visible.map((it) => (
                <ShareCard
                  key={it.id}
                  item={it}
                  now={now}
                  showPreview={showPreviews}
                  onDelete={onDelete}
                  onSetExpiry={onSetExpiry}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}
