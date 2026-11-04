/**
 * Reine Geometrie-Hilfen für die Screenshot-Auswahl. Bewusst ohne Electron-/DOM-
 * Abhängigkeiten, damit sie eigenständig getestet werden können. Alle Koordinaten
 * sind CSS-/DIP-Pixel, relativ zur linken oberen Ecke des jeweiligen Monitors.
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DetectedWindow extends Rect {
  title: string
}

/** Zwei Punkte (Drag) zu einem normalisierten Rechteck machen. */
export function rectFromPoints(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  }
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height
}

/**
 * Automatische Fenster-Erkennung: das VORDERSTE Fenster zurückgeben, das den Cursor
 * enthält. Die Liste kommt in Z-Reihenfolge (vorne zuerst) – der erste Treffer ist
 * also genau das Fenster, das man an dieser Stelle tatsächlich sieht.
 */
export function topmostWindowAt(px: number, py: number, windows: DetectedWindow[]): Rect | null {
  for (const w of windows) {
    if (w.width <= 0 || w.height <= 0) continue
    if (pointInRect(px, py, w)) return { x: w.x, y: w.y, width: w.width, height: w.height }
  }
  return null
}

/**
 * Rechteck allseitig um `by` Pixel nach innen beschneiden. Für die automatische
 * Fenster-Auswahl: der von Windows gemeldete (schon rahmenbereinigte) Fensterrand
 * enthält direkt an der Kante noch einen hauchdünnen Schatten-/Rundecken-Saum. Ein
 * winziger Einzug nimmt exakt diese Kante weg, statt einen Streifen Desktop drumherum
 * mitzunehmen. Sehr kleine Fenster bleiben unverändert (sonst schnitte man zu viel weg).
 */
export function insetRect(r: Rect, by: number): Rect {
  if (by <= 0) return r
  if (r.width <= by * 2 + 4 || r.height <= by * 2 + 4) return r
  return { x: r.x + by, y: r.y + by, width: r.width - by * 2, height: r.height - by * 2 }
}

/** Rechteck auf die Monitorfläche begrenzen (keine negativen Ränder). */
export function clampToBounds(r: Rect, boundsW: number, boundsH: number): Rect {
  const x = Math.max(0, Math.min(r.x, boundsW))
  const y = Math.max(0, Math.min(r.y, boundsH))
  const width = Math.max(0, Math.min(r.width, boundsW - x))
  const height = Math.max(0, Math.min(r.height, boundsH - y))
  return { x, y, width, height }
}

/** Cursor am oberen Rand (< threshold px) → Vollbild-Auswahl anbieten. */
export function isNearTopEdge(py: number, threshold = 8): boolean {
  return py <= threshold
}

/** Erst ab dieser Distanz gilt eine Mausbewegung als bewusstes Ziehen. */
export function isDrag(x1: number, y1: number, x2: number, y2: number, min = 4): boolean {
  return Math.abs(x2 - x1) >= min || Math.abs(y2 - y1) >= min
}

/** DIP-Auswahl in physische Bildpixel umrechnen (für den Zuschnitt). */
export function toPhysicalRect(r: Rect, scaleFactor: number): Rect {
  return {
    x: Math.round(r.x * scaleFactor),
    y: Math.round(r.y * scaleFactor),
    width: Math.round(r.width * scaleFactor),
    height: Math.round(r.height * scaleFactor)
  }
}
