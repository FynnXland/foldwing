/**
 * Name und Marke für alles, was der Main-Prozess zeigt: Fenster, Infobereich,
 * Meldungen und die Freigabe-Seiten. Der Renderer hat sein Gegenstück in
 * src/renderer/src/brand.ts. Bei einer Umbenennung beide ändern.
 *
 * Bis 1.3.x hieß die App „FlowShare“. Was beim Update vom alten Namen
 * übernommen oder aufgeräumt wird, steht in legacy.ts.
 */
export const APP_NAME = 'Foldwing'

/**
 * Papierflieger-Marke im Low-Poly-Stil: blaue Kachel, weiße Tragfläche,
 * hellblaue Gegenseite, dunkelblauer Kiel. Gleiche Form wie scripts/make-icon.mjs
 * und docs/media/logo.svg.
 */
export const LOGO_PATHS =
  '<rect width="120" height="120" rx="26" fill="#2563eb"/>' +
  '<path d="M106 18 L8 56 L42 70 L64 77 Z" fill="#ffffff"/>' +
  '<path d="M106 18 L64 77 L58 110 Z" fill="#c3d6ff"/>' +
  '<path d="M42 70 L64 77 L58 110 Z" fill="#1a3d9c"/>'

/** Die Marke als fertiges SVG in der gewünschten Kantenlänge (px). */
export function logoSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${LOGO_PATHS}</svg>`
}
