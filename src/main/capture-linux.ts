import { execFile } from 'child_process'
import type { RawWindow } from './capture-windows'

/**
 * Sichtbare Top-Level-Fenster unter Linux/X11 ermitteln – über die Standard-
 * Werkzeuge xprop/xwininfo (Paket x11-utils, auf Kubuntu vorinstalliert), ganz
 * ohne natives Addon. Läuft rein lokal; es wird nur die Fenster-Geometrie
 * gelesen, kein Bildinhalt.
 *
 * Ablauf: _NET_CLIENT_LIST_STACKING liefert alle Fenster in Z-Reihenfolge
 * (unterstes zuerst); pro Fenster holen xwininfo (Geometrie, Sichtbarkeit) und
 * xprop (Titel, Zustand, Typ, Rahmen) die Details – parallel, das dauert auf
 * einem üblichen Desktop nur wenige Dutzend Millisekunden und läuft ohnehin
 * nebenher, während das Aufnahme-Overlay schon steht.
 *
 * Rückgabe wie beim Windows-Helfer: PHYSISCHE, globale Koordinaten in
 * Z-REIHENFOLGE (vorderstes Fenster zuerst). Minimierte Fenster, Panels/Docks
 * und unsichtbare Fenster werden gefiltert. Unter Wayland gibt es diese
 * Schnittstellen nicht – dann kommt eine leere Liste (Ziehen/Vollbild gehen
 * weiter, nur die automatische Fenster-Auswahl entfällt).
 */

/** Obergrenze, damit ein Fenster-Sturm nicht Dutzende Prozesse startet. */
const MAX_WINDOWS = 40

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) =>
        resolve(err ? '' : String(stdout))
      )
    } catch {
      resolve('')
    }
  })
}

/** Fenster-IDs aus `xprop -root _NET_CLIENT_LIST_STACKING` (unterstes zuerst). */
export function parseStackingIds(text: string): number[] {
  if (!text.includes('_NET_CLIENT_LIST_STACKING')) return []
  const ids: number[] = []
  for (const m of text.matchAll(/0x[0-9a-fA-F]+/g)) {
    const n = parseInt(m[0], 16)
    if (Number.isFinite(n) && n > 0) ids.push(n)
  }
  return ids
}

export interface XWinGeometry {
  x: number
  y: number
  width: number
  height: number
  viewable: boolean
}

/** Geometrie + Sichtbarkeit aus der `xwininfo -id <id>`-Ausgabe. */
export function parseXwininfo(text: string): XWinGeometry | null {
  const num = (re: RegExp): number | null => {
    const m = re.exec(text)
    return m ? parseInt(m[1], 10) : null
  }
  const x = num(/Absolute upper-left X:\s*(-?\d+)/)
  const y = num(/Absolute upper-left Y:\s*(-?\d+)/)
  const width = num(/Width:\s*(\d+)/)
  const height = num(/Height:\s*(\d+)/)
  if (x === null || y === null || width === null || height === null) return null
  return { x, y, width, height, viewable: /Map State:\s*IsViewable/.test(text) }
}

export interface XWindowProps {
  title: string
  hidden: boolean
  skipTaskbar: boolean
  /** _NET_WM_WINDOW_TYPE, sofern gesetzt (z. B. "_NET_WM_WINDOW_TYPE_DOCK"). */
  type: string | null
  /** Fenster-Dekoration links/rechts/oben/unten (Pixel), sofern gemeldet. */
  frame: { left: number; right: number; top: number; bottom: number } | null
}

/** Titel/Zustand/Typ/Rahmen aus der gebündelten `xprop -id <id> …`-Ausgabe. */
export function parseXprops(text: string): XWindowProps {
  const title =
    /_NET_WM_NAME\(UTF8_STRING\) = "((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ??
    /WM_NAME\((?:UTF8_)?STRING\) = "((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ??
    ''
  const state = /_NET_WM_STATE\(ATOM\) = ([^\n]*)/.exec(text)?.[1] ?? ''
  const type = /_NET_WM_WINDOW_TYPE\(ATOM\) = ([^\n]*)/.exec(text)?.[1]?.trim() || null
  const fm = /_NET_FRAME_EXTENTS\(CARDINAL\) = (\d+), (\d+), (\d+), (\d+)/.exec(text)
  return {
    // xprop escapet " und \ in Titeln mit Backslash -> zurückübersetzen.
    title: title.replace(/\\(.)/g, '$1'),
    hidden: state.includes('_NET_WM_STATE_HIDDEN'),
    skipTaskbar: state.includes('_NET_WM_STATE_SKIP_TASKBAR'),
    type,
    frame: fm
      ? { left: +fm[1], right: +fm[2], top: +fm[3], bottom: +fm[4] }
      : null
  }
}

/**
 * Nur normale Fenster und Dialoge sind Aufnahme-Ziele (keine Panels/Docks/
 * Desktops). Ein Fenster kann MEHRERE Typen melden (nach EWMH in absteigender
 * Priorität; die Plasma-Leiste etwa "DOCK, …, NORMAL") – es zählt der erste.
 */
export function isCapturableType(type: string | null): boolean {
  if (!type) return true // Typ nicht gesetzt -> wie NORMAL behandeln (ältere Apps)
  const first = type.split(',')[0]?.trim() ?? ''
  return first === '_NET_WM_WINDOW_TYPE_NORMAL' || first === '_NET_WM_WINDOW_TYPE_DIALOG'
}

/** Details eines Fensters holen und zu einem RawWindow zusammensetzen (oder null). */
async function inspectWindow(id: number, timeoutMs: number): Promise<RawWindow | null> {
  const hex = '0x' + id.toString(16)
  const [info, props] = await Promise.all([
    run('xwininfo', ['-id', hex], timeoutMs),
    run(
      'xprop',
      ['-id', hex, '_NET_WM_NAME', 'WM_NAME', '_NET_WM_STATE', '_NET_WM_WINDOW_TYPE', '_NET_FRAME_EXTENTS'],
      timeoutMs
    )
  ])
  const geo = parseXwininfo(info)
  if (!geo || !geo.viewable) return null
  const p = parseXprops(props)
  if (!p.title || p.hidden || p.skipTaskbar || !isCapturableType(p.type)) return null
  // Rahmen (Titelleiste etc.) dazurechnen: das sichtbare Fenster ist größer als
  // das Client-Rechteck, das xwininfo meldet.
  const f = p.frame ?? { left: 0, right: 0, top: 0, bottom: 0 }
  const left = geo.x - f.left
  const top = geo.y - f.top
  const right = geo.x + geo.width + f.right
  const bottom = geo.y + geo.height + f.bottom
  if (right - left < 20 || bottom - top < 20 || left <= -30000) return null
  return { left, top, right, bottom, title: p.title, hwnd: id }
}

export async function enumerateWindowsX11(
  timeoutMs = 2000,
  exclude?: Set<number>
): Promise<RawWindow[]> {
  const stacking = parseStackingIds(
    await run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING'], timeoutMs)
  )
  if (stacking.length === 0) return []
  // Stapel umdrehen (vorderstes zuerst) und eigene Aufnahme-Fenster ausnehmen.
  const ids = stacking
    .reverse()
    .filter((id) => !(exclude?.has(id)))
    .slice(0, MAX_WINDOWS)
  const results = await Promise.all(ids.map((id) => inspectWindow(id, timeoutMs)))
  return results.filter((w): w is RawWindow => w !== null)
}
