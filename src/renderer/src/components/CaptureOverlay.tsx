import { useCallback, useEffect, useRef, useState } from 'react'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}
interface Win extends Rect {
  title: string
}
interface InitData {
  displayId: number
  scaleFactor: number
  bounds: { width: number; height: number }
  image: string
  windows: Win[]
  magnifier: boolean
}

const TOP_EDGE = 8
const DRAG_MIN = 4
// Lupe: Kantenlänge, Zoomfaktor, Abstand zum Cursor.
const LOUPE = 132
const ZOOM = 8
const LOUPE_OFF = 13

function rectFromPoints(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}
/** Vorderstes Fenster unter dem Cursor – die Liste kommt in Z-Reihenfolge (vorne zuerst). */
function topmostWindowAt(px: number, py: number, wins: Win[]): Rect | null {
  for (const w of wins) {
    if (px < w.x || px > w.x + w.width || py < w.y || py > w.y + w.height) continue
    return { x: w.x, y: w.y, width: w.width, height: w.height }
  }
  return null
}

/**
 * Vollbild-Overlay pro Monitor: dunkelt den (bereits aufgenommenen) Screen ab und
 * hellt die aktuelle Auswahl auf. Auswahl per Ziehen, Klick auf ein erkanntes
 * Fenster, oder Vollbild am oberen Rand. Esc und Rechtsklick brechen ab. Die blaue
 * Outline zeichnet sich beim ersten Erscheinen einmal rundherum; danach folgt sie
 * den Fenstern, ohne sich neu zu zeichnen. Optional zeigt eine Pixel-Lupe (Taste M)
 * die Stelle unter dem Cursor vergrößert.
 */
export function CaptureOverlay(): JSX.Element {
  const [data, setData] = useState<InitData | null>(null)
  const [selection, setSelection] = useState<Rect | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  // Outline pro Aufnahme genau einmal „zeichnen", dann konstant halten.
  const [drawn, setDrawn] = useState(false)
  const [magOn, setMagOn] = useState(true)
  // Zählt jede Aufnahme hoch -> spielt die Einblende-Animation neu ab.
  const [nonce, setNonce] = useState(0)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const mouse = useRef<{ x: number; y: number } | null>(null)

  useEffect(
    () =>
      window.foldwing.onCaptureInit((d) => {
        dragStart.current = null
        mouse.current = null
        setSelection(null)
        setCursor(null)
        setDrawn(false)
        setMagOn(d.magnifier)
        setData(d)
        setNonce((n) => n + 1)
        // Nach zwei Frames ist das neue Standbild gezeichnet -> Main darf zeigen.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.foldwing.captureReady(d.displayId))
        )
      }),
    []
  )

  // Fensterliste kommt asynchron nach – Auswahl unter dem Cursor sofort aktualisieren.
  useEffect(
    () =>
      window.foldwing.onCaptureWindows(({ windows }) => {
        setData((prev) => (prev ? { ...prev, windows } : prev))
        const m = mouse.current
        if (m && !dragStart.current && m.y > TOP_EDGE) {
          setSelection(topmostWindowAt(m.x, m.y, windows))
        }
      }),
    []
  )

  useEffect(
    () =>
      window.foldwing.onCaptureReset(() => {
        dragStart.current = null
        mouse.current = null
        setSelection(null)
        setCursor(null)
        setData(null)
      }),
    []
  )

  const cancel = useCallback(() => window.foldwing.captureCancel(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
      else if (e.key === 'm' || e.key === 'M') setMagOn((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  const onMove = (e: React.MouseEvent): void => {
    if (!data) return
    const x = e.clientX
    const y = e.clientY
    mouse.current = { x, y }
    setCursor({ x, y })
    if (dragStart.current) {
      setSelection(rectFromPoints(dragStart.current.x, dragStart.current.y, x, y))
    } else if (y <= TOP_EDGE) {
      setSelection({ x: 0, y: 0, width: data.bounds.width, height: data.bounds.height })
    } else {
      setSelection(topmostWindowAt(x, y, data.windows))
    }
  }

  const onDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    dragStart.current = { x: e.clientX, y: e.clientY }
  }

  const onUp = (e: React.MouseEvent): void => {
    if (!data || e.button !== 0) return
    const start = dragStart.current
    dragStart.current = null
    if (start) {
      const moved = Math.abs(e.clientX - start.x) >= DRAG_MIN || Math.abs(e.clientY - start.y) >= DRAG_MIN
      if (moved) {
        const r = rectFromPoints(start.x, start.y, e.clientX, e.clientY)
        if (r.width > 2 && r.height > 2) window.foldwing.captureConfirm(data.displayId, r)
        return
      }
    }
    // Klick ohne Ziehen: aktuelle Auto-/Vollbild-Auswahl bestätigen.
    if (selection && selection.width > 2 && selection.height > 2) {
      window.foldwing.captureConfirm(data.displayId, selection)
    }
  }

  if (!data) return <div className="cap-root" />

  const s = selection

  // Lupe rechts-unten vom Cursor; kein Platz -> nach links/oben ausweichen.
  let loupe: { x: number; y: number; bg: string } | null = null
  if (magOn && cursor) {
    let lx = cursor.x + LOUPE_OFF
    let ly = cursor.y + LOUPE_OFF
    if (lx + LOUPE > data.bounds.width) lx = cursor.x - LOUPE_OFF - LOUPE
    if (ly + LOUPE > data.bounds.height) ly = cursor.y - LOUPE_OFF - LOUPE
    lx = Math.max(4, Math.min(lx, data.bounds.width - LOUPE - 4))
    ly = Math.max(4, Math.min(ly, data.bounds.height - LOUPE - 4))
    loupe = {
      x: lx,
      y: ly,
      bg: `${LOUPE / 2 - cursor.x * ZOOM}px ${LOUPE / 2 - cursor.y * ZOOM}px`
    }
  }

  // Rechteck-Pfad für die „sich zeichnende" Outline (Start oben links, im Uhrzeigersinn).
  const framePath = s ? `M1 1 H ${Math.max(1, s.width - 1)} V ${Math.max(1, s.height - 1)} H 1 Z` : ''

  return (
    <div
      className="cap-root"
      onMouseMove={onMove}
      onMouseDown={onDown}
      onMouseUp={onUp}
      onContextMenu={(e) => {
        e.preventDefault()
        cancel()
      }}
    >
      <img className="cap-img" src={data.image} draggable={false} alt="" />

      {/* Abdunklung + Hinweis blenden sanft ein (key -> Animation je Aufnahme neu). */}
      <div className="cap-overlay" key={nonce}>
        {/* als Rahmen um die Auswahl (oder ganzflächig, wenn keine). */}
        {s ? (
          <>
            <div className="cap-dim" style={{ left: 0, top: 0, width: '100%', height: s.y }} />
            <div className="cap-dim" style={{ left: 0, top: s.y + s.height, width: '100%', bottom: 0 }} />
            <div className="cap-dim" style={{ left: 0, top: s.y, width: s.x, height: s.height }} />
            <div className="cap-dim" style={{ left: s.x + s.width, top: s.y, right: 0, height: s.height }} />
            <div className="cap-sel" style={{ left: s.x, top: s.y, width: s.width, height: s.height }}>
              <svg className="cap-sel__frame" width={s.width} height={s.height} aria-hidden>
                <path
                  d={framePath}
                  pathLength={100}
                  className={`cap-sel__stroke${drawn ? '' : ' cap-sel__stroke--draw'}`}
                  onAnimationEnd={() => setDrawn(true)}
                />
              </svg>
              <span className="cap-size">
                {Math.round(s.width)} × {Math.round(s.height)}
              </span>
            </div>
          </>
        ) : (
          <div className="cap-dim" style={{ inset: 0 }} />
        )}

        <div className="cap-hint">
          <span>Bereich aufziehen oder Fenster anklicken</span>
          <span className="cap-hint__sep" aria-hidden />
          <span>Ganz oben an den Rand: ganzer Bildschirm</span>
          <span className="cap-hint__sep" aria-hidden />
          <span>
            <kbd>M</kbd>Lupe
          </span>
          <span>
            <kbd>Esc</kbd>Abbrechen
          </span>
        </div>
      </div>

      {/* Pixel-Lupe (folgt dem Cursor, weicht an den Rändern aus). */}
      {loupe && (
        <div className="cap-loupe" style={{ left: loupe.x, top: loupe.y, width: LOUPE, height: LOUPE }}>
          <div
            className="cap-loupe__img"
            style={{
              backgroundImage: `url(${data.image})`,
              backgroundSize: `${data.bounds.width * ZOOM}px ${data.bounds.height * ZOOM}px`,
              backgroundPosition: loupe.bg
            }}
          />
          <div
            className="cap-loupe__box"
            style={{ width: ZOOM, height: ZOOM }}
          />
          <div className="cap-loupe__cross cap-loupe__cross--h" />
          <div className="cap-loupe__cross cap-loupe__cross--v" />
          <div className="cap-loupe__label">
            {cursor ? `${Math.round(cursor.x * data.scaleFactor)}, ${Math.round(cursor.y * data.scaleFactor)}` : ''}
          </div>
        </div>
      )}
    </div>
  )
}
