import { promises as fsp } from 'fs'
import { Readable } from 'stream'

/**
 * Streamender ZIP-Schreiber ohne Fremd-Abhängigkeit.
 *
 * Immer Methode 0 ("stored", keine Kompression): Foldwing liefert verlustfrei
 * aus, und die typischen Freigaben (Bilder, Video, PDF) sind ohnehin komprimiert.
 * Dadurch ist die Archivgröße vorab exakt berechenbar -> der HTTP-Server kann
 * `Content-Length` setzen und der Browser zeigt einen echten Fortschritt.
 *
 * Der Speicherverbrauch ist konstant: Dateien werden in 64-KB-Häppchen gelesen
 * und sofort weitergereicht. Im RAM bleibt nur das zentrale Inhaltsverzeichnis
 * (rund 46 Byte + Name pro Eintrag), das erst am Ende geschrieben werden kann.
 */

export interface ZipEntry {
  /** Anzeigename im Archiv (wird intern abgesichert, siehe zipEntryNames). */
  name: string
  /** Absoluter Pfad der Quelldatei auf der Platte. */
  path: string
  /** Größe in Bytes – MUSS der tatsächlichen Dateigröße entsprechen. */
  size: number
  /** Änderungszeit für den Archiv-Eintrag; fehlt = jetzt. */
  mtime?: Date
}

const LOCAL_SIG = 0x04034b50
const DD_SIG = 0x08074b50
const CEN_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const Z64_EOCD_SIG = 0x06064b50
const Z64_LOC_SIG = 0x07064b50

const LOCAL_BASE = 30 // fester Teil des lokalen Headers
const CEN_BASE = 46 // fester Teil eines Verzeichnis-Eintrags
const EOCD_LEN = 22
const DD_LEN_32 = 16 // Signatur + CRC + 2x 4-Byte-Größe
const DD_LEN_64 = 24 // Signatur + CRC + 2x 8-Byte-Größe
const Z64_LOCAL_EXTRA = 20 // 4 Byte Kopf + 2x 8 Byte (unkompr./kompr. Größe)
const Z64_CEN_EXTRA = 28 // 4 Byte Kopf + 3x 8 Byte (Größen + lokaler Offset)
const Z64_EOCD_LEN = 56
const Z64_LOC_LEN = 20

const U32_MAX = 0xffffffff
const U16_MAX = 0xffff
const MAX_NAME_BYTES = 200 // Namenslänge ist ein uint16-Feld – harte Obergrenze nötig
const CHUNK = 64 * 1024

/** Flags: Bit 3 = Größen stehen im Data Descriptor, Bit 11 = Name ist UTF-8. */
const FLAGS = 0x0808

// ---------------------------------------------------------------- Namen

/** Steuerzeichen als \uXXXX-Escapes (rohe Bytes brechen die Werkzeuge, CLAUDE.md §6). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/**
 * Einen einzelnen Namen auf einen reinen Dateinamen eindampfen: Pfadanteile,
 * Laufwerksbuchstaben und Alternate-Data-Stream-Doppelpunkte fallen weg, ebenso
 * Steuerzeichen sowie führende/abschließende Punkte und Leerzeichen. Damit wird
 * ".." zu einem leeren Rest und landet bei "datei" – im Archiv kann also kein
 * Pfad stehen (Zip-Slip).
 */
function safeName(raw: string): string {
  let s = typeof raw === 'string' ? raw : ''
  s = s.replace(CONTROL_CHARS, '')
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'), s.lastIndexOf(':'))
  if (cut >= 0) s = s.slice(cut + 1)
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!s) return 'datei'

  if (Buffer.byteLength(s, 'utf8') > MAX_NAME_BYTES) {
    const [base, ext] = splitExt(s)
    const room = MAX_NAME_BYTES - Buffer.byteLength(ext, 'utf8')
    let cutBase = base
    while (cutBase.length > 1 && Buffer.byteLength(cutBase, 'utf8') > room) {
      cutBase = cutBase.slice(0, -1)
    }
    s = (cutBase + ext).replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
    if (!s) return 'datei'
  }
  return s
}

/** "bild.png" -> ["bild", ".png"]; ohne Endung -> ["name", ""]. */
function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.')
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, '']
}

/**
 * Namen absichern und eindeutig machen. Duplikate werden zu "bild (2).png",
 * "bild (3).png" usw. – die Endung bleibt erhalten.
 *
 * Bewusste Entscheidung: Der Duplikat-Vergleich ist NICHT case-sensitiv.
 * Windows und macOS behandeln Dateinamen unabhängig von Groß-/Kleinschreibung;
 * "Bild.PNG" und "bild.png" würden sich beim Entpacken sonst gegenseitig
 * überschreiben. "Bild.PNG" gefolgt von "bild.png" ergibt also
 * ["Bild.PNG", "bild (2).png"] – die Schreibweise des Originals bleibt jeweils
 * erhalten, nur die Kollisionsprüfung ignoriert sie.
 */
export function zipEntryNames(names: string[]): string[] {
  const used = new Set<string>()
  const counter = new Map<string, number>()
  const out: string[] = []

  for (const raw of names) {
    const safe = safeName(raw)
    const key = safe.toLowerCase()
    if (!used.has(key)) {
      used.add(key)
      counter.set(key, 1)
      out.push(safe)
      continue
    }
    const [base, ext] = splitExt(safe)
    let n = counter.get(key) ?? 1
    let candidate: string
    let candidateKey: string
    do {
      n++
      candidate = `${base} (${n})${ext}`
      candidateKey = candidate.toLowerCase()
    } while (used.has(candidateKey))
    counter.set(key, n)
    used.add(candidateKey)
    out.push(candidate)
  }
  return out
}

// ---------------------------------------------------------------- CRC32

/** Standard-Tabelle, IEEE-Polynom 0xEDB88320 – einmalig aufgebaut. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** CRC32 fortschreiben; Startwert für den ersten Aufruf ist 0. */
export function crc32Update(crc: number, data: Uint8Array): number {
  let c = (crc ^ U32_MAX) >>> 0
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0
  }
  return (c ^ U32_MAX) >>> 0
}

/** CRC32 eines kompletten Puffers. */
export function crc32(data: Uint8Array): number {
  return crc32Update(0, data)
}

// ---------------------------------------------------------------- Layout

interface Layout {
  names: string[]
  nameLens: number[]
  zip64: boolean
  total: number
}

function checkedSize(entry: ZipEntry): number {
  const size = Number(entry.size)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Ungültige Größe für "${entry.name}": ${entry.size}`)
  }
  return size
}

/**
 * ZIP64 ja/nein – die Regel, und zwar allein aus den Eintragsgrößen ableitbar,
 * damit zipSize() exakt dasselbe Layout vorhersagt, das createZipStream() dann
 * erzeugt:
 *
 * Erst wird das Archiv im 32-Bit-Layout durchgerechnet. ZIP64 wird nötig, sobald
 * eines der 32-Bit-Felder seinen Sentinel-Wert erreicht:
 *   - eine Datei ist >= 4 GiB - 1,
 *   - der lokale Bereich (= Offset des Inhaltsverzeichnisses) >= 4 GiB - 1
 *     (damit ist auch jeder einzelne lokale Header-Offset abgedeckt),
 *   - das Inhaltsverzeichnis selbst >= 4 GiB - 1,
 *   - das Gesamtarchiv >= 4 GiB - 1,
 *   - oder es gibt >= 65535 Einträge.
 *
 * Das ist widerspruchsfrei, weil das ZIP64-Layout immer GRÖSSER ist als das
 * 32-Bit-Layout: Was im kleineren Layout schon über die Grenze geht, geht im
 * größeren erst recht darüber. Ein Zurückkippen kann also nicht passieren.
 */
export function needsZip64(entries: ZipEntry[]): boolean {
  const names = zipEntryNames(entries.map((e) => e.name))
  let local = 0
  let central = 0
  for (let i = 0; i < entries.length; i++) {
    const size = checkedSize(entries[i])
    if (size >= U32_MAX) return true
    const nameLen = Buffer.byteLength(names[i], 'utf8')
    local += LOCAL_BASE + nameLen + size + DD_LEN_32
    central += CEN_BASE + nameLen
  }
  return (
    entries.length >= U16_MAX ||
    local >= U32_MAX ||
    central >= U32_MAX ||
    local + central + EOCD_LEN >= U32_MAX
  )
}

function layout(entries: ZipEntry[]): Layout {
  const names = zipEntryNames(entries.map((e) => e.name))
  const nameLens = names.map((n) => Buffer.byteLength(n, 'utf8'))
  const zip64 = needsZip64(entries)
  const ddLen = zip64 ? DD_LEN_64 : DD_LEN_32
  const localExtra = zip64 ? Z64_LOCAL_EXTRA : 0
  const cenExtra = zip64 ? Z64_CEN_EXTRA : 0

  let total = 0
  for (let i = 0; i < entries.length; i++) {
    total += LOCAL_BASE + nameLens[i] + localExtra + checkedSize(entries[i]) + ddLen
    total += CEN_BASE + nameLens[i] + cenExtra
  }
  total += EOCD_LEN
  if (zip64) total += Z64_EOCD_LEN + Z64_LOC_LEN
  return { names, nameLens, zip64, total }
}

/** Exakte Bytelänge des Archivs, das createZipStream für diese Einträge erzeugt. */
export function zipSize(entries: ZipEntry[]): number {
  return layout(entries).total
}

// ---------------------------------------------------------------- Header

/** DOS-Zeit/Datum aus der lokalen Zeit; Sekunden werden auf 2 gerundet. */
function dosDateTime(d: Date): { time: number; date: number } {
  const valid = d instanceof Date && !Number.isNaN(d.getTime())
  const when = valid ? d : new Date()
  const year = when.getFullYear()
  if (year < 1980) return { time: 0, date: 0x0021 } // 1980-01-01, kleinster darstellbarer Wert
  if (year > 2107) return { time: 0xbf7d, date: 0xff9f } // größter darstellbarer Wert
  const time =
    (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2)
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  return { time, date }
}

function localHeader(nameBuf: Buffer, when: Date, zip64: boolean): Buffer {
  const extraLen = zip64 ? Z64_LOCAL_EXTRA : 0
  const buf = Buffer.alloc(LOCAL_BASE + nameBuf.length + extraLen)
  const { time, date } = dosDateTime(when)
  buf.writeUInt32LE(LOCAL_SIG, 0)
  buf.writeUInt16LE(zip64 ? 45 : 20, 4)
  buf.writeUInt16LE(FLAGS, 6)
  buf.writeUInt16LE(0, 8) // Methode 0 = stored
  buf.writeUInt16LE(time, 10)
  buf.writeUInt16LE(date, 12)
  // CRC und Größen sind beim Streamen noch unbekannt -> stehen im Data Descriptor.
  buf.writeUInt32LE(0, 14)
  buf.writeUInt32LE(zip64 ? U32_MAX : 0, 18)
  buf.writeUInt32LE(zip64 ? U32_MAX : 0, 22)
  buf.writeUInt16LE(nameBuf.length, 26)
  buf.writeUInt16LE(extraLen, 28)
  nameBuf.copy(buf, LOCAL_BASE)
  if (zip64) {
    // ZIP64-Extra mit Platzhaltern: signalisiert dem Leser 8-Byte-Felder im
    // Data Descriptor.
    const p = LOCAL_BASE + nameBuf.length
    buf.writeUInt16LE(0x0001, p)
    buf.writeUInt16LE(16, p + 2)
  }
  return buf
}

function dataDescriptor(crc: number, size: number, zip64: boolean): Buffer {
  const buf = Buffer.alloc(zip64 ? DD_LEN_64 : DD_LEN_32)
  buf.writeUInt32LE(DD_SIG, 0)
  buf.writeUInt32LE(crc >>> 0, 4)
  if (zip64) {
    buf.writeBigUInt64LE(BigInt(size), 8)
    buf.writeBigUInt64LE(BigInt(size), 16)
  } else {
    buf.writeUInt32LE(size, 8)
    buf.writeUInt32LE(size, 12)
  }
  return buf
}

function centralEntry(
  nameBuf: Buffer,
  when: Date,
  crc: number,
  size: number,
  localOffset: number,
  zip64: boolean
): Buffer {
  const extraLen = zip64 ? Z64_CEN_EXTRA : 0
  const buf = Buffer.alloc(CEN_BASE + nameBuf.length + extraLen)
  const { time, date } = dosDateTime(when)
  buf.writeUInt32LE(CEN_SIG, 0)
  buf.writeUInt16LE(zip64 ? 45 : 20, 4) // erzeugt von
  buf.writeUInt16LE(zip64 ? 45 : 20, 6) // benötigt
  buf.writeUInt16LE(FLAGS, 8)
  buf.writeUInt16LE(0, 10)
  buf.writeUInt16LE(time, 12)
  buf.writeUInt16LE(date, 14)
  buf.writeUInt32LE(crc >>> 0, 16)
  buf.writeUInt32LE(zip64 ? U32_MAX : size, 20)
  buf.writeUInt32LE(zip64 ? U32_MAX : size, 24)
  buf.writeUInt16LE(nameBuf.length, 28)
  buf.writeUInt16LE(extraLen, 30)
  buf.writeUInt16LE(0, 32) // Kommentar
  buf.writeUInt16LE(0, 34) // Startdiskette
  buf.writeUInt16LE(0, 36) // interne Attribute
  buf.writeUInt32LE(0, 38) // externe Attribute
  buf.writeUInt32LE(zip64 ? U32_MAX : localOffset, 42)
  nameBuf.copy(buf, CEN_BASE)
  if (zip64) {
    const p = CEN_BASE + nameBuf.length
    buf.writeUInt16LE(0x0001, p)
    buf.writeUInt16LE(24, p + 2)
    buf.writeBigUInt64LE(BigInt(size), p + 4)
    buf.writeBigUInt64LE(BigInt(size), p + 12)
    buf.writeBigUInt64LE(BigInt(localOffset), p + 20)
  }
  return buf
}

function endRecords(count: number, cdSize: number, cdOffset: number, zip64: boolean): Buffer {
  const buf = Buffer.alloc(zip64 ? Z64_EOCD_LEN + Z64_LOC_LEN + EOCD_LEN : EOCD_LEN)
  let p = 0
  if (zip64) {
    buf.writeUInt32LE(Z64_EOCD_SIG, 0)
    buf.writeBigUInt64LE(BigInt(Z64_EOCD_LEN - 12), 4) // Größe ab hier
    buf.writeUInt16LE(45, 12)
    buf.writeUInt16LE(45, 14)
    buf.writeUInt32LE(0, 16)
    buf.writeUInt32LE(0, 20)
    buf.writeBigUInt64LE(BigInt(count), 24)
    buf.writeBigUInt64LE(BigInt(count), 32)
    buf.writeBigUInt64LE(BigInt(cdSize), 40)
    buf.writeBigUInt64LE(BigInt(cdOffset), 48)
    p = Z64_EOCD_LEN

    buf.writeUInt32LE(Z64_LOC_SIG, p)
    buf.writeUInt32LE(0, p + 4)
    buf.writeBigUInt64LE(BigInt(cdOffset + cdSize), p + 8) // Offset des ZIP64-EOCD
    buf.writeUInt32LE(1, p + 16)
    p += Z64_LOC_LEN
  }
  buf.writeUInt32LE(EOCD_SIG, p)
  buf.writeUInt16LE(0, p + 4)
  buf.writeUInt16LE(0, p + 6)
  buf.writeUInt16LE(zip64 ? U16_MAX : count, p + 8)
  buf.writeUInt16LE(zip64 ? U16_MAX : count, p + 10)
  buf.writeUInt32LE(zip64 ? U32_MAX : cdSize, p + 12)
  buf.writeUInt32LE(zip64 ? U32_MAX : cdOffset, p + 16)
  buf.writeUInt16LE(0, p + 20)
  return buf
}

// ---------------------------------------------------------------- Stream

/**
 * Genau `size` Bytes aus der Datei lesen. Ist die Datei kürzer, wird ein Fehler
 * geworfen – sonst stimmte die vorab gemeldete Content-Length nicht mehr. Ist
 * sie länger, wird bei `size` abgeschnitten, aus demselben Grund.
 */
async function* fileChunks(path: string, size: number): AsyncGenerator<Buffer> {
  const fh = await fsp.open(path, 'r')
  try {
    let rest = size
    while (rest > 0) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, rest))
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (bytesRead <= 0) throw new Error(`Datei kürzer als angegeben: ${path}`)
      rest -= bytesRead
      yield bytesRead === buf.length ? buf : buf.subarray(0, bytesRead)
    }
  } finally {
    await fh.close()
  }
}

async function* zipChunks(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const { names, zip64 } = layout(entries)
  const central: Buffer[] = []
  let offset = 0

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const size = checkedSize(entry)
    const when = entry.mtime instanceof Date ? entry.mtime : new Date()
    const nameBuf = Buffer.from(names[i], 'utf8')
    const localOffset = offset

    const header = localHeader(nameBuf, when, zip64)
    yield header
    offset += header.length

    let crc = 0
    for await (const chunk of fileChunks(entry.path, size)) {
      crc = crc32Update(crc, chunk)
      yield chunk
    }
    offset += size

    const dd = dataDescriptor(crc, size, zip64)
    yield dd
    offset += dd.length

    central.push(centralEntry(nameBuf, when, crc, size, localOffset, zip64))
  }

  const cdOffset = offset
  let cdSize = 0
  for (const buf of central) {
    yield buf
    cdSize += buf.length
  }
  yield endRecords(entries.length, cdSize, cdOffset, zip64)
}

/**
 * Archiv streamen. Lesefehler einer Quelldatei beenden den Stream mit einem
 * `error`-Event (der Server bricht die Antwort dann ab).
 */
export function createZipStream(entries: ZipEntry[]): Readable {
  return Readable.from(zipChunks(entries), { objectMode: false })
}
