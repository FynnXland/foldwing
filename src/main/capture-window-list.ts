import type { RawWindow } from './capture-windows'
import {
  enumerateWindows as enumerateWindowsWin,
  disposeWindowHelper as disposeWin
} from './capture-windows'
import { enumerateWindowsX11 } from './capture-linux'
import { isLinux, isWindows, isX11Session } from './platform'

/**
 * Plattform-Weiche für die Fenster-Erkennung der Screenshot-Aufnahme:
 * Windows nutzt den PowerShell-Helfer (startet bei der ersten Abfrage), Linux/X11
 * xprop/xwininfo. Unter Wayland (und allem anderen) gibt es keine Fensterliste – die
 * Aufnahme funktioniert dann weiter über Ziehen und Vollbild.
 */
export type { RawWindow }

export function enumerateWindows(timeoutMs = 2000, exclude?: Set<number>): Promise<RawWindow[]> {
  if (isWindows) return enumerateWindowsWin(timeoutMs, exclude)
  if (isLinux && isX11Session()) return enumerateWindowsX11(timeoutMs, exclude)
  return Promise.resolve([])
}

/** Helfer beenden (nur Windows hält einen Prozess – X11-Abfragen laufen je Aufruf). */
export function disposeWindowHelper(): void {
  if (isWindows) disposeWin()
}
