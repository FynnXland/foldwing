import { promises as fsp } from 'fs'

/**
 * Minimaler ZIP-Verzeichnisleser: liest NUR das zentrale Inhaltsverzeichnis am
 * Dateiende (so ist das ZIP-Format aufgebaut) – dadurch funktioniert die
 * Inhaltsvorschau auch bei riesigen Archiven mit konstant kleinem Speicher.
 * ZIP64 (>4 GB bzw. >65k Einträge) wird nicht unterstützt -> null (generische Ansicht).
 */
export interface ZipEntry {
  path: string
  size: number
  dir: boolean
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

export async function listZipEntries(
  file: string,
  maxEntries = 1000
): Promise<{ entries: ZipEntry[]; total: number } | null> {
  let fh: fsp.FileHandle | null = null
  try {
    fh = await fsp.open(file, 'r')
    const stat = await fh.stat()
    if (stat.size < 22) return null

    // "End of Central Directory" am Dateiende suchen (max. 64 KB + Kommentar).
    const tailLen = Math.min(stat.size, 65557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, stat.size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null

    const total = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (cdOffset === 0xffffffff || total === 0xffff) return null // ZIP64
    if (cdSize > 32 * 1024 * 1024) return null // absurd großes Verzeichnis

    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)

    const entries: ZipEntry[] = []
    let p = 0
    while (p + 46 <= cd.length && entries.length < maxEntries) {
      if (cd.readUInt32LE(p) !== CEN_SIG) break
      const flags = cd.readUInt16LE(p + 8)
      const size = cd.readUInt32LE(p + 24) // unkomprimierte Größe
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const raw = cd.subarray(p + 46, p + 46 + nameLen)
      const path = raw.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1')
      entries.push({ path, size, dir: path.endsWith('/') })
      p += 46 + nameLen + extraLen + commentLen
    }
    return { entries, total }
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}
