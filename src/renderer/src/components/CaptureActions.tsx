import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

type Action = 'save' | 'edit' | 'copy' | 'upload'
type Done = { type: 'upload'; url: string } | { type: 'copy' }

/**
 * Aktionsleiste direkt nach der Aufnahme: Link teilen (Upload), Kopieren,
 * Speichern oder Bearbeiten. Zeigt Lade- und Erfolgszustand an und schließt
 * sich danach selbst. Enter = Link teilen, Strg+C = Kopieren, Esc = Schließen.
 */
export function CaptureActions(): JSX.Element {
  const [data, setData] = useState<{ image: string; width: number; height: number } | null>(null)
  const [busy, setBusy] = useState<Action | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<number[]>([])

  useEffect(() => window.foldwing.onCaptureActionsInit((d) => setData(d)), [])
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t)
    },
    []
  )

  const close = useCallback(() => window.foldwing.captureActionsClose(), [])
  const closeSoon = (ms: number): void => {
    timers.current.push(window.setTimeout(close, ms))
  }

  const run = useCallback(
    async (type: Action): Promise<void> => {
      if (busy || done) return
      setError(null)
      setBusy(type)
      const r = await window.foldwing.captureAction(type)
      if (type === 'save' || type === 'edit') {
        close()
        return
      }
      if (type === 'copy') {
        setDone({ type: 'copy' })
        closeSoon(900)
        return
      }
      // Upload: Link ist kopiert; Leiste bleibt offen für „nochmal kopieren" /
      // „im Browser öffnen" und schließt sich beim Klick daneben (Blur) oder mit Esc.
      if (r.ok && r.url) {
        setDone({ type: 'upload', url: r.url })
      } else {
        setError(r.error ?? 'Das Teilen hat nicht geklappt. Versuch es noch einmal.')
        setBusy(null)
      }
    },
    [busy, done, close]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
      else if (e.key === 'Enter') void run('upload')
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') void run('copy')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, close])

  return (
    <div className="capbar">
      {data && <img className="capbar__thumb" src={data.image} alt="" />}
      <div className="capbar__body">
        <div className="capbar__head">
          <div>
            <div className="capbar__title">Screenshot fertig</div>
            <div className="capbar__meta">
              {data ? `${data.width} × ${data.height} Pixel · ` : ''}Enter teilt den Link
            </div>
          </div>
          <button className="icon-btn capbar__close" title="Schließen (Esc)" aria-label="Schließen" onClick={close}>
            <Icon name="x" size={15} />
          </button>
        </div>

        {error && (
          <div className="capbar__err" role="alert">
            {error}
          </div>
        )}

        <div className="capbar__row">
          {done?.type === 'upload' ? (
            <div className="capbar__done" role="status">
              <Icon name="check" size={16} />
              Link kopiert
              <span className="capbar__done-url">{done.url}</span>
              <button
                className="icon-btn icon-btn--boxed"
                title="Link noch mal kopieren"
                aria-label="Link noch mal kopieren"
                onClick={() => void navigator.clipboard.writeText(done.url)}
              >
                <Icon name="copy" size={14} />
              </button>
              <button
                className="icon-btn icon-btn--boxed"
                title="Im Browser öffnen"
                aria-label="Im Browser öffnen"
                onClick={() => {
                  void window.foldwing.openExternal(done.url)
                  close()
                }}
              >
                <Icon name="external" size={14} />
              </button>
            </div>
          ) : done?.type === 'copy' ? (
            <div className="capbar__done" role="status">
              <Icon name="check" size={16} />
              Liegt in der Zwischenablage
            </div>
          ) : (
            <>
              <button
                className="btn btn--primary btn--sm btn--icon"
                disabled={!!busy}
                onClick={() => run('upload')}
                title="Teilen und Link kopieren (Enter)"
              >
                <Icon name="link" size={14} />
                {busy === 'upload' ? 'Wird geteilt …' : 'Als Link teilen'}
              </button>
              <button
                className="icon-btn icon-btn--boxed"
                disabled={!!busy}
                onClick={() => run('copy')}
                title="In die Zwischenablage kopieren (Strg+C)"
                aria-label="In die Zwischenablage kopieren"
              >
                <Icon name="copy" size={15} />
              </button>
              <button
                className="icon-btn icon-btn--boxed"
                disabled={!!busy}
                onClick={() => run('save')}
                title="Als Datei speichern"
                aria-label="Als Datei speichern"
              >
                <Icon name="save" size={15} />
              </button>
              <button
                className="icon-btn icon-btn--boxed"
                disabled={!!busy}
                onClick={() => run('edit')}
                title="Im Bildprogramm bearbeiten"
                aria-label="Im Bildprogramm bearbeiten"
              >
                <Icon name="edit" size={15} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
