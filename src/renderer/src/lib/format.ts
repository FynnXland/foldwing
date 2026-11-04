/** Größe lesbar machen, mit deutschem Dezimalkomma (die Oberfläche ist deutsch). */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`
}

/** Gut lesbarer, unmissverständlicher Raum-Code (ohne 0/O/1/I). */
export function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const values = new Uint32Array(6)
  crypto.getRandomValues(values)
  for (let i = 0; i < 6; i++) code += alphabet[values[i] % alphabet.length]
  return code
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

/** Restlaufzeit menschenlesbar (z. B. "24 Std.", "7 Tage"). */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'abgelaufen'
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'unter 1 Min.'
  if (min < 60) return `${min} Min.`
  const h = Math.round(min / 60)
  if (h < 48) return h === 1 ? '1 Std.' : `${h} Std.`
  const d = Math.round(h / 24)
  return d === 1 ? '1 Tag' : `${d} Tage`
}
