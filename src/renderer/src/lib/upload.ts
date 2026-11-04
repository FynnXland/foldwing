import type { Share } from '../types'

const CHUNK_SIZE = 1024 * 1024 // 1 MiB pro IPC-Runde

/**
 * Lädt eine Datei gestreamt in den eingebetteten Server (über den Main-Prozess).
 * Die Datei wird in Blöcken gelesen und übergeben, damit auch sehr große Dateien
 * den Arbeitsspeicher nicht überlasten.
 */
export async function uploadShare(
  file: File,
  onProgress: (progress: number) => void
): Promise<Share> {
  const mime = file.type || 'application/octet-stream'
  const id = await window.foldwing.shareBegin(file.name, mime)

  try {
    let offset = 0
    while (offset < file.size) {
      const slice = file.slice(offset, offset + CHUNK_SIZE)
      const buf = await slice.arrayBuffer()
      const res = await window.foldwing.shareChunk(id, buf)
      if (!res.ok) throw new Error('Die Datei ließ sich nicht in die Ablage schreiben. Versuch es noch einmal.')
      offset += buf.byteLength
      onProgress(file.size === 0 ? 1 : offset / file.size)
    }

    const done = await window.foldwing.shareEnd(id)
    if (!done.ok) throw new Error(done.error ?? 'Das Teilen hat nicht geklappt. Versuch es noch einmal.')
    return done.share
  } catch (err) {
    await window.foldwing.shareAbort(id).catch(() => {})
    throw err
  }
}

/**
 * Lädt mehrere Dateien als EINE Freigabe hoch – ein Link für alles.
 * Der Fortschritt zählt über alle Dateien zusammen (Bytes gesamt), damit der
 * Balken in der Karte einmal sauber von 0 auf 100 läuft.
 */
export async function uploadBundle(
  files: File[],
  onProgress: (progress: number) => void
): Promise<Share> {
  const total = files.reduce((sum, f) => sum + f.size, 0)
  const { id, uploads } = await window.foldwing.bundleBegin(
    files.map((f) => ({ name: f.name, mime: f.type || 'application/octet-stream' }))
  )

  try {
    if (uploads.length !== files.length) throw new Error('Die Sammlung ließ sich nicht anlegen. Versuch es noch einmal.')

    let sent = 0
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const uploadId = uploads[i].uploadId
      let offset = 0
      while (offset < file.size) {
        const slice = file.slice(offset, offset + CHUNK_SIZE)
        const buf = await slice.arrayBuffer()
        const res = await window.foldwing.shareChunk(uploadId, buf)
        if (!res.ok) throw new Error('Die Datei ließ sich nicht in die Ablage schreiben. Versuch es noch einmal.')
        offset += buf.byteLength
        sent += buf.byteLength
        onProgress(total === 0 ? 1 : sent / total)
      }
    }

    const done = await window.foldwing.bundleEnd(id)
    if (!done.ok) throw new Error(done.error ?? 'Das Teilen hat nicht geklappt. Versuch es noch einmal.')
    onProgress(1)
    return done.share
  } catch (err) {
    await window.foldwing.bundleAbort(id).catch(() => {})
    throw err
  }
}
