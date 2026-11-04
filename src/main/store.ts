import { createWriteStream, WriteStream, promises as fsp } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

/** Eine einzelne Datei innerhalb einer Sammel-Freigabe. */
export interface ShareFile {
  /** Kurz-ID der Datei INNERHALB der Freigabe (base62, ~6 Zeichen). */
  fid: string
  name: string
  mime: string
  size: number
}

export interface ShareMeta {
  id: string
  name: string
  mime: string
  size: number
  createdAt: number
  /** Zeitstempel, ab dem die Freigabe abläuft; fehlt/0 = permanent. */
  expiresAt?: number
  /** Nur bei Sammlungen gesetzt. Fehlt = klassische Einzeldatei (Altbestand!). */
  files?: ShareFile[]
}

/** Pseudo-MIME, an dem eine Sammlung erkennbar ist. */
export const BUNDLE_MIME = 'application/x-foldwing-bundle'

/** true, wenn die Freigabe mehrere Dateien bündelt. */
export function isBundle(meta: ShareMeta): boolean {
  return Array.isArray(meta?.files)
}

/** Datei einer Sammlung anhand ihrer fid finden (null, wenn unbekannt). */
export function bundleFile(meta: ShareMeta, fid: string): ShareFile | null {
  if (!meta || !Array.isArray(meta.files)) return null
  return meta.files.find((f) => f.fid === fid) ?? null
}

export function isExpired(meta: ShareMeta): boolean {
  return !!meta.expiresAt && meta.expiresAt <= Date.now()
}

/** Anzeigenamen absichern: Steuerzeichen raus, Länge begrenzen. */
function cleanFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (stripped || 'datei').slice(0, 200)
}

/** URL-sicherer, gut verteilter Kurz-Code (base62). */
function makeCode(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(length)
  let id = ''
  for (const b of bytes) id += alphabet[b % alphabet.length]
  return id
}

/** Kennung einer Freigabe (~10 Zeichen). */
function makeId(): string {
  return makeCode(10)
}

/** Kennung einer Datei innerhalb einer Sammlung (~6 Zeichen). */
function makeFid(): string {
  return makeCode(6)
}

/**
 * Persistente Ablage der Freigaben. Jede Freigabe besteht aus den Rohbytes
 * (`<id>.bin`) und einer Metadatei (`<id>.json`). Uploads werden gestreamt,
 * damit auch sehr große Dateien den Speicher nicht sprengen.
 */
interface PendingUpload {
  name: string
  mime: string
  stream: WriteStream
  /** Zieldatei auf der Platte. */
  path: string
  /** Freigabe, zu der dieser Upload gehört. */
  shareId: string
  /** Nur bei Sammlungen: Kennung der Datei innerhalb der Freigabe. */
  fid?: string
  /** Erster Schreibfehler des Streams; ab dann ist der Upload verloren. */
  error?: Error
}

export class ShareStore {
  private pending = new Map<string, PendingUpload>()
  /** Offene Sammlungen: Freigabe-ID -> Upload-Kennungen in Übergabe-Reihenfolge. */
  private bundles = new Map<string, string[]>()
  /** Letztes Lebenszeichen (Anlegen/Schreiben) je Freigabe mit offenem Upload. */
  private activity = new Map<string, number>()

  constructor(private dataDir: string) {}

  /** Läuft gerade ein Upload, der weder abgeschlossen noch abgebrochen ist? */
  hasPendingUploads(): boolean {
    return this.pending.size > 0 || this.bundles.size > 0
  }

  /** Hat diese Freigabe noch einen offenen Upload? */
  private isOpen(shareId: string): boolean {
    if (this.bundles.has(shareId)) return true
    for (const p of this.pending.values()) if (p.shareId === shareId) return true
    return false
  }

  /** Lebenszeichen vergessen, sobald zur Freigabe nichts mehr offen ist. */
  private settle(shareId: string): void {
    if (!this.isOpen(shareId)) this.activity.delete(shareId)
  }

  /**
   * Verwaiste Uploads verwerfen: kein Lebenszeichen seit `maxIdleMs`, etwa weil
   * das Fenster mitten im Hochladen abgestürzt ist oder neu geladen hat. Sonst
   * hielte so ein Upload das Teilen (Server + Tunnel) für immer wach. Bei
   * Sammlungen zählt die ganze Freigabe – ihre Dateien laufen nacheinander.
   * Gibt die verworfenen Freigabe-IDs zurück.
   */
  async abortStaleUploads(maxIdleMs: number, now = Date.now()): Promise<string[]> {
    const open = new Set<string>(this.bundles.keys())
    for (const p of this.pending.values()) open.add(p.shareId)
    const stale: string[] = []
    for (const id of open) {
      if (now - (this.activity.get(id) ?? 0) < maxIdleMs) continue
      stale.push(id)
      if (this.bundles.has(id)) {
        await this.abortBundle(id)
        continue
      }
      for (const [uploadId, p] of [...this.pending]) {
        if (p.shareId === id) await this.abort(uploadId)
      }
    }
    return stale
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.dataDir, { recursive: true })
  }

  /** Rohdaten-Pfad: ohne fid die klassische Einzeldatei, mit fid eine Teildatei. */
  binPath(id: string, fid?: string): string {
    if (!fid) return join(this.dataDir, `${id}.bin`)
    // Die fid landet indirekt aus der URL hier — nur base62 zulassen, damit
    // niemand über den Pfad aus dem Datenverzeichnis ausbrechen kann.
    return join(this.dataDir, `${id}-${fid.replace(/[^A-Za-z0-9]/g, '')}.bin`)
  }

  private metaPath(id: string): string {
    return join(this.dataDir, `${id}.json`)
  }

  /** Upload eröffnen, Stream anlegen und unter uploadId vormerken. */
  private open(uploadId: string, shareId: string, name: string, mime: string, fid?: string): void {
    const path = this.binPath(shareId, fid)
    const stream = createWriteStream(path)
    const p: PendingUpload = { name: cleanFileName(name), mime, stream, path, shareId, fid }
    // Ohne diesen Listener würde ein Schreibfehler (Platte voll, Volume weg,
    // EACCES) als unbehandeltes 'error'-Event den Main-Prozess killen.
    stream.on('error', (e: Error) => {
      if (!p.error) p.error = e
    })
    this.pending.set(uploadId, p)
    this.activity.set(shareId, Date.now())
  }

  /** Neuen Upload eröffnen und Schreib-Stream bereitstellen. */
  begin(name: string, mime: string): string {
    const id = makeId()
    this.open(id, id, name, mime)
    return id
  }

  /**
   * Sammel-Upload eröffnen: eine Freigabe, mehrere Dateien. Die zurückgegebene
   * uploadId ist der Schlüssel für write()/abort(), die fid identifiziert die
   * Datei später innerhalb der Freigabe.
   */
  beginBundle(files: { name: string; mime: string }[]): {
    id: string
    uploads: { fid: string; uploadId: string }[]
  } {
    if (!files || files.length === 0) throw new Error('Keine Dateien')
    const id = makeId()
    const uploads: { fid: string; uploadId: string }[] = []
    const uploadIds: string[] = []
    const used = new Set<string>()
    for (const f of files) {
      let fid = makeFid()
      while (used.has(fid)) fid = makeFid()
      used.add(fid)
      const uploadId = `${id}-${fid}`
      this.open(uploadId, id, f.name, f.mime, fid)
      uploadIds.push(uploadId)
      uploads.push({ fid, uploadId })
    }
    this.bundles.set(id, uploadIds)
    return { id, uploads }
  }

  /**
   * Auf "drain" warten, aber gegen Fehler/Ende des Streams rennen — sonst
   * käme das drain nach einem Fehler nie und der Aufrufer hinge für immer.
   */
  private waitDrain(p: PendingUpload): Promise<void> {
    if (p.error || p.stream.destroyed || p.stream.writableEnded) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        p.stream.off('drain', done)
        p.stream.off('error', done)
        p.stream.off('close', done)
        resolve()
      }
      p.stream.once('drain', done)
      p.stream.once('error', done)
      p.stream.once('close', done)
    })
  }

  /** Stream schließen und die angefangene Datei entfernen; wirft nie. */
  private async discard(path: string, stream?: WriteStream): Promise<void> {
    if (stream && !stream.destroyed) {
      await new Promise<void>((resolve) => {
        stream.once('close', resolve)
        stream.destroy()
      })
    }
    // Windows gibt Datei-Handles verzögert frei — ein Fehlschlag hier darf
    // den Aufrufer nicht umwerfen.
    await fsp.rm(path, { force: true }).catch(() => {})
  }

  /**
   * Alle Teildateien `<id>-*.bin` aus dem Verzeichnis räumen. Fängt auch
   * Leichen ab, deren Metadatei schon weg ist (Absturz mitten im Upload).
   * Wirft nie.
   */
  private async removeParts(id: string): Promise<void> {
    const entries = await fsp.readdir(this.dataDir).catch(() => [] as string[])
    const prefix = `${id}-`
    for (const e of entries) {
      if (e.startsWith(prefix) && e.endsWith('.bin')) {
        await fsp.rm(join(this.dataDir, e), { force: true }).catch(() => {})
      }
    }
  }

  /**
   * Stream sauber beenden. Gibt den Fehler zurück, wenn das Schreiben
   * fehlgeschlagen ist (sonst null). Der 'end'-Callback kommt bei einem
   * kaputten Stream unter Umständen nicht — deshalb gegen error/close rennen.
   */
  private endStream(p: PendingUpload): Promise<Error | null> {
    if (p.error) return Promise.resolve(p.error)
    return new Promise<Error | null>((resolve) => {
      let settled = false
      const finish = (err?: Error | null): void => {
        if (settled) return
        settled = true
        p.stream.off('error', onError)
        p.stream.off('close', onClose)
        resolve(p.error ?? err ?? null)
      }
      const onError = (e: Error): void => finish(e)
      const onClose = (): void => finish(null)
      p.stream.once('error', onError)
      p.stream.once('close', onClose)
      p.stream.end(() => finish(null))
    })
  }

  /** Einen Chunk schreiben; wartet bei Bedarf auf "drain" (Backpressure). */
  async write(uploadId: string, chunk: Buffer): Promise<boolean> {
    const p = this.pending.get(uploadId)
    if (!p) return false
    this.activity.set(p.shareId, Date.now())
    if (p.error) {
      await this.abort(uploadId)
      return false
    }
    if (!p.stream.write(chunk)) {
      await this.waitDrain(p)
    }
    if (p.error) {
      await this.abort(uploadId)
      return false
    }
    return true
  }

  /** Upload abschließen, Metadaten schreiben und zurückgeben (Einzeldatei). */
  async finalize(uploadId: string, expiresAt?: number): Promise<ShareMeta | null> {
    const p = this.pending.get(uploadId)
    if (!p) return null
    // Teile einer Sammlung gehören zu finalizeBundle(), sonst entstünde eine
    // Metadatei, die nur eine der Dateien kennt.
    if (p.fid) return null
    const failure = await this.endStream(p)
    this.pending.delete(uploadId)
    this.settle(p.shareId)
    if (failure) {
      await this.discard(p.path, p.stream)
      return null
    }
    let stat: { size: number }
    try {
      stat = await fsp.stat(p.path)
    } catch {
      await this.discard(p.path, p.stream)
      return null
    }
    const meta: ShareMeta = {
      id: p.shareId,
      name: p.name,
      mime: p.mime || 'application/octet-stream',
      size: stat.size,
      createdAt: Date.now(),
      ...(expiresAt ? { expiresAt } : {})
    }
    await fsp.writeFile(this.metaPath(p.shareId), JSON.stringify(meta))
    return meta
  }

  /**
   * Sammlung abschließen: alle Streams schließen, echte Größen ermitteln und
   * EINE Metadatei schreiben. Scheitert ein Teil, wird die ganze Freigabe
   * verworfen — lieber nichts als eine halbe Sammlung.
   */
  async finalizeBundle(id: string, expiresAt?: number): Promise<ShareMeta | null> {
    const uploadIds = this.bundles.get(id)
    if (!uploadIds || uploadIds.length === 0) return null
    this.bundles.delete(id)
    // Alle Teile werden gleich hier abgeschlossen oder verworfen.
    this.activity.delete(id)

    const files: ShareFile[] = []
    let failed = false
    for (const uploadId of uploadIds) {
      const p = this.pending.get(uploadId)
      if (!p) {
        // Teil wurde zwischendurch abgebrochen -> Sammlung ist unvollständig.
        failed = true
        continue
      }
      this.pending.delete(uploadId)
      const failure = await this.endStream(p)
      if (failure) {
        await this.discard(p.path, p.stream)
        failed = true
        continue
      }
      try {
        const stat = await fsp.stat(p.path)
        files.push({
          fid: p.fid!,
          name: p.name,
          mime: p.mime || 'application/octet-stream',
          size: stat.size
        })
      } catch {
        failed = true
      }
    }

    if (failed || files.length !== uploadIds.length) {
      await this.removeParts(id)
      return null
    }

    const meta: ShareMeta = {
      id,
      name: `${files.length} ${files.length === 1 ? 'Datei' : 'Dateien'}`,
      mime: BUNDLE_MIME,
      size: files.reduce((sum, f) => sum + f.size, 0),
      createdAt: Date.now(),
      ...(expiresAt ? { expiresAt } : {}),
      files
    }
    await fsp.writeFile(this.metaPath(id), JSON.stringify(meta))
    return meta
  }

  /** Ablaufzeit einer Freigabe ändern (null = permanent). */
  async setExpiry(id: string, expiresAt: number | null): Promise<ShareMeta | null> {
    const meta = await this.get(id)
    if (!meta) return null
    if (expiresAt) meta.expiresAt = expiresAt
    else delete meta.expiresAt
    await fsp.writeFile(this.metaPath(id), JSON.stringify(meta))
    return meta
  }

  /** Abgelaufene Freigaben löschen; gibt die entfernten IDs zurück. */
  async sweepExpired(): Promise<string[]> {
    const removed: string[] = []
    for (const meta of await this.list()) {
      if (isExpired(meta)) {
        await this.remove(meta.id)
        removed.push(meta.id)
      }
    }
    return removed
  }

  async abort(uploadId: string): Promise<void> {
    const p = this.pending.get(uploadId)
    if (p) {
      this.pending.delete(uploadId)
      this.settle(p.shareId)
      await this.discard(p.path, p.stream)
    }
  }

  /** Sammlung verwerfen: offene Uploads schließen, Teildateien löschen. */
  async abortBundle(id: string): Promise<void> {
    const uploadIds = this.bundles.get(id) ?? []
    this.bundles.delete(id)
    this.activity.delete(id)
    for (const uploadId of uploadIds) {
      const p = this.pending.get(uploadId)
      if (!p) continue
      this.pending.delete(uploadId)
      await this.discard(p.path, p.stream)
    }
    await this.removeParts(id)
  }

  async get(id: string): Promise<ShareMeta | null> {
    try {
      const raw = await fsp.readFile(this.metaPath(id), 'utf-8')
      return JSON.parse(raw) as ShareMeta
    } catch {
      return null
    }
  }

  async list(): Promise<ShareMeta[]> {
    const files = await fsp.readdir(this.dataDir).catch(() => [])
    const metas: ShareMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        metas.push(JSON.parse(await fsp.readFile(join(this.dataDir, f), 'utf-8')))
      } catch {
        /* defekte Metadatei überspringen */
      }
    }
    return metas.sort((a, b) => b.createdAt - a.createdAt)
  }

  async remove(id: string): Promise<void> {
    // Noch laufende Sammel-Uploads erst stoppen — sonst legen ihre Streams die
    // gerade gelöschten Teildateien direkt wieder an. abortBundle() räumt dabei
    // gleich alle <id>-*.bin weg: das deckt die in der Metadatei gelisteten
    // Dateien ab UND Leichen, deren Metadatei schon fehlt.
    await this.abortBundle(id)
    await fsp.rm(this.binPath(id), { force: true })
    await fsp.rm(this.metaPath(id), { force: true })
    this.pending.delete(id)
    this.settle(id)
  }
}
