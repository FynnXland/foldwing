import { useEffect, useRef, useState } from 'react'
import type { ShareItem } from '../types'
import { formatBytes, formatRemaining } from '../lib/format'
import { Icon, type IconName } from './Icon'

interface Props {
  item: ShareItem
  now: number
  showPreview: boolean
  onDelete: (item: ShareItem) => void
  onSetExpiry: (item: ShareItem, expiresAt: number | null) => void
}

const HOUR = 3_600_000

type Kind = 'image' | 'video' | 'pdf' | 'doc' | 'sheet' | 'zip' | 'audio' | 'file' | 'bundle'

const KIND_ICON: Record<Kind, IconName> = {
  image: 'image',
  video: 'video',
  pdf: 'file-text',
  doc: 'file-text',
  sheet: 'table',
  zip: 'archive',
  audio: 'music',
  file: 'file',
  // Zwei gestapelte Blätter: mehrere Dateien, ein Link.
  bundle: 'copy'
}

/** Deutsche Bezeichnung der Art, dieselben Wörter wie auf der Empfänger-Seite. */
const KIND_LABEL: Record<Kind, string> = {
  image: 'Bild',
  video: 'Video',
  pdf: 'PDF',
  doc: 'Dokument',
  sheet: 'Tabelle',
  zip: 'Archiv',
  audio: 'Audio',
  file: 'Datei',
  bundle: 'Sammlung'
}

function detectKind(name: string, mime: string): Kind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf'
  if (/\.(zip|rar|7z)$/i.test(name) || mime.includes('zip')) return 'zip'
  if (/\.(xlsx?|csv)$/i.test(name)) return 'sheet'
  if (/\.(docx?|odt|rtf)$/i.test(name)) return 'doc'
  return 'file'
}

const VISIBLE_FILES = 5
/** So lange wartet „Wirklich löschen?“ auf den zweiten Klick. */
const CONFIRM_MS = 4000

/** Ablauf in Worten, für die Auswahl in der Karte. */
function expiryText(remaining: number | null): string {
  if (remaining === null) return 'Läuft nie ab'
  if (remaining <= 0) return 'Abgelaufen'
  return `Läuft in ${formatRemaining(remaining)} ab`
}

/** Eine Freigabe: Datei, Link mit Kopieren, Ablauf, Öffnen und Löschen. */
export function ShareCard({ item, now, showPreview, onDelete, onSetExpiry }: Props): JSX.Element {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const timers = useRef<number[]>([])
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t)
    },
    []
  )
  const later = (fn: () => void, ms: number): void => {
    timers.current.push(window.setTimeout(fn, ms))
  }

  const pct = Math.round(item.progress * 100)
  const files = item.files ?? []
  const isBundle = files.length > 0
  const kind = isBundle ? 'bundle' : detectKind(item.name, item.mime)
  const shown = expanded ? files : files.slice(0, VISIBLE_FILES)
  const hidden = files.length - shown.length

  const copyLink = async (): Promise<void> => {
    if (!item.url) return
    try {
      await navigator.clipboard.writeText(item.url)
      setCopied('ok')
    } catch {
      setCopied('fail')
    }
    later(() => setCopied(null), 1800)
  }

  const open = (): void => {
    if (item.url) window.foldwing.openExternal(item.url)
  }

  const changeExpiry = (value: string): void => {
    if (value === '') return
    onSetExpiry(item, value === 'never' ? null : Date.now() + Number(value) * HOUR)
  }

  const askDelete = (): void => {
    if (confirmDelete || item.status === 'failed') {
      onDelete(item)
      return
    }
    setConfirmDelete(true)
    later(() => setConfirmDelete(false), CONFIRM_MS)
  }

  const remaining = item.expiresAt ? item.expiresAt - now : null
  const expirySoon = remaining !== null && remaining < HOUR

  const meta = isBundle
    ? `Sammlung · ${formatBytes(item.size)}`
    : `${KIND_LABEL[kind]} · ${formatBytes(item.size)}`

  return (
    <article className={`card share-card ${item.status === 'failed' ? 'share-card--failed' : ''}`} aria-label={item.name}>
      {!isBundle && showPreview && item.previewUrl && kind === 'image' && (
        <img className="share-card__preview" src={item.previewUrl} alt="" />
      )}
      {!isBundle && showPreview && item.previewUrl && kind === 'video' && (
        <video className="share-card__preview" src={item.previewUrl} controls />
      )}

      <div className="ftile">
        <div className={`ftile__icon kind--${kind}`} aria-hidden>
          <Icon name={KIND_ICON[kind]} size={20} />
        </div>
        <div className="ftile__body">
          <div className="ftile__name" title={item.name}>
            {item.name}
          </div>
          {item.status === 'uploading' ? (
            <div className="ftile__progress">
              <span
                className="ftile__bar"
                role="progressbar"
                aria-label="Fortschritt"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ width: `${pct}%` }} />
              </span>
              <span className="ftile__pct">Wird vorbereitet · {pct} %</span>
            </div>
          ) : (
            <div className="ftile__meta">{meta}</div>
          )}
        </div>
        {item.status !== 'uploading' && (
          confirmDelete ? (
            <button className="btn btn--danger btn--sm" onClick={askDelete}>
              Wirklich löschen?
            </button>
          ) : (
            <button
              className="icon-btn icon-btn--danger"
              title={item.status === 'failed' ? 'Entfernen' : 'Freigabe löschen'}
              aria-label={item.status === 'failed' ? 'Entfernen' : 'Freigabe löschen'}
              onClick={askDelete}
            >
              <Icon name="trash" size={16} />
            </button>
          )
        )}
      </div>

      {isBundle && (
        <ul className="bundle-list" aria-label="Dateien in dieser Freigabe">
          {shown.map((f, i) => {
            const k = detectKind(f.name, f.mime)
            const thumb = showPreview && f.previewUrl && k === 'image'
            return (
              <li className="bundle-list__row" key={f.fid ?? `${i}-${f.name}`}>
                {thumb ? (
                  <img className="bundle-list__thumb" src={f.previewUrl} alt="" />
                ) : (
                  <span className={`bundle-list__icon kind--${k}`} aria-hidden>
                    <Icon name={KIND_ICON[k]} size={15} />
                  </span>
                )}
                <span className="bundle-list__name" title={f.name}>
                  {f.name}
                </span>
                <span className="bundle-list__size">{formatBytes(f.size)}</span>
              </li>
            )
          })}
          {(hidden > 0 || expanded) && (
            <li>
              <button className="bundle-list__more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                {expanded ? 'Weniger zeigen' : `${hidden} weitere zeigen`}
              </button>
            </li>
          )}
        </ul>
      )}

      {item.status === 'done' && item.url && (
        <>
          <div className="linkfield">
            <Icon name="link" size={16} />
            <span className="linkfield__url" title={item.url}>
              {item.url}
            </span>
            <button
              className={`linkfield__btn ${copied === 'ok' ? 'linkfield__btn--copied' : ''}`}
              onClick={copyLink}
            >
              <Icon name={copied === 'ok' ? 'check' : 'copy'} size={14} />
              {copied === 'ok' ? 'Kopiert' : copied === 'fail' ? 'Ging nicht' : 'Link kopieren'}
            </button>
            <span className="sr-only" aria-live="polite">
              {copied === 'ok' ? 'Link kopiert' : copied === 'fail' ? 'Kopieren hat nicht geklappt' : ''}
            </span>
          </div>

          <div className="share-card__foot">
            <span className="expiry">
              <Icon name="clock" size={15} />
              <select
                className={`select ${expirySoon ? 'select--soon' : ''}`}
                value=""
                aria-label={`Ablauf: ${expiryText(remaining)}. Ändern`}
                onChange={(e) => changeExpiry(e.target.value)}
              >
                <option value="" hidden>
                  {expiryText(remaining)}
                </option>
                <optgroup label="Ablauf ändern">
                  <option value="1">In 1 Stunde</option>
                  <option value="24">In 24 Stunden</option>
                  <option value="168">In 7 Tagen</option>
                  <option value="720">In 30 Tagen</option>
                  <option value="never">Nie</option>
                </optgroup>
              </select>
            </span>
            <span className="spacer" />
            <button className="btn btn--ghost btn--sm" onClick={open}>
              <Icon name="external" size={14} />
              Im Browser öffnen
            </button>
          </div>
        </>
      )}

      {item.status === 'failed' && (
        <p className="share-card__error" role="alert">
          {item.error || 'Das Teilen hat nicht geklappt. Versuch es noch einmal.'}
        </p>
      )}
    </article>
  )
}
