import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  zipEntryNames,
  zipSize,
  createZipStream,
  needsZip64,
  crc32,
  type ZipEntry
} from '../src/main/zip-write'
import { listZipEntries } from '../src/main/zip'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'foldwing-zipwrite-test-'))
}

/** Archiv vollständig einsammeln (nur für Tests – im Betrieb wird gestreamt). */
async function collect(entries: ZipEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of createZipStream(entries)) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Datei anlegen und passenden ZipEntry liefern. */
function put(dir: string, file: string, data: Buffer, name = file): ZipEntry {
  const path = join(dir, file)
  writeFileSync(path, data)
  return { name, path, size: data.length, mtime: new Date(2024, 4, 17, 13, 45, 30) }
}

// ------------------------------------------------------------- 1. Namen

test('zipEntryNames: Pfadanteile, ".." und Steuerzeichen verschwinden', () => {
  const control = 'bo' + String.fromCharCode(0x07) + 'se' + String.fromCharCode(0x00) + '.txt'
  const got = zipEntryNames([
    '..\\..\\evil.txt',
    'a/b/c.png',
    'C:\\x\\y.pdf',
    '..',
    '...',
    '../../../etc/passwd',
    control,
    '   ',
    '',
    'C:datei.txt',
    'normal.jpg'
  ])
  assert.deepEqual(got, [
    'evil.txt',
    'c.png',
    'y.pdf',
    'datei',
    'datei (2)',
    'passwd',
    'bose.txt',
    'datei (3)',
    'datei (4)',
    'datei.txt',
    'normal.jpg'
  ])
  for (const n of got) {
    assert.ok(!n.includes('/') && !n.includes('\\') && !n.includes(':'), `kein Pfad in "${n}"`)
    assert.ok(!n.startsWith('.'), `kein führender Punkt in "${n}"`)
  }
})

test('zipEntryNames: Duplikate werden durchnummeriert, Endung bleibt', () => {
  assert.deepEqual(zipEntryNames(['bild.png', 'bild.png', 'bild.png']), [
    'bild.png',
    'bild (2).png',
    'bild (3).png'
  ])
})

test('zipEntryNames: Duplikate ohne Endung', () => {
  assert.deepEqual(zipEntryNames(['README', 'README', 'README']), [
    'README',
    'README (2)',
    'README (3)'
  ])
})

test('zipEntryNames: Kollisionsprüfung ignoriert Groß-/Kleinschreibung', () => {
  // Bewusst case-insensitiv: Windows/macOS würden die Dateien sonst
  // beim Entpacken überschreiben. Die Original-Schreibweise bleibt erhalten.
  assert.deepEqual(zipEntryNames(['Bild.PNG', 'bild.png', 'BILD.png']), [
    'Bild.PNG',
    'bild (2).png',
    'BILD (3).png'
  ])
})

test('zipEntryNames: bereits vergebene Nummer wird übersprungen', () => {
  assert.deepEqual(zipEntryNames(['a.txt', 'a (2).txt', 'a.txt', 'a.txt']), [
    'a.txt',
    'a (2).txt',
    'a (3).txt',
    'a (4).txt'
  ])
})

test('zipEntryNames: absurd langer Name wird gekürzt, Endung überlebt', () => {
  const [name] = zipEntryNames(['x'.repeat(5000) + '.png'])
  assert.ok(Buffer.byteLength(name, 'utf8') <= 200)
  assert.ok(name.endsWith('.png'))
})

// ------------------------------------------------ 2. zipSize == Realität

test('zipSize entspricht exakt der Byteanzahl von createZipStream', async () => {
  const dir = makeTmpDir()
  try {
    const cases: Array<{ label: string; entries: ZipEntry[] }> = []

    cases.push({
      label: 'eine Datei',
      entries: [put(dir, 'eins.txt', Buffer.from('Hallo Welt'))]
    })

    cases.push({
      label: 'drei Dateien',
      entries: [
        put(dir, 'a.bin', randomBytes(1000)),
        put(dir, 'b.bin', randomBytes(1)),
        put(dir, 'c.bin', randomBytes(70000))
      ]
    })

    cases.push({
      label: 'Umlaute und Emoji im Namen',
      entries: [
        put(dir, 'umlaut1.bin', randomBytes(50), 'Größenübersicht Ärger.txt'),
        put(dir, 'umlaut2.bin', randomBytes(50), 'Foto 📸 vom Süden.jpg')
      ]
    })

    cases.push({
      label: '0-Byte-Datei',
      entries: [put(dir, 'leer.bin', Buffer.alloc(0))]
    })

    cases.push({ label: 'gar keine Datei', entries: [] })

    const many: ZipEntry[] = []
    for (let i = 0; i < 50; i++) many.push(put(dir, `viele-${i}.bin`, randomBytes(100 + i)))
    cases.push({ label: '50 Dateien', entries: many })

    // Gleiche Namen -> zipSize muss dieselbe Umbenennung rechnen wie der Stream.
    cases.push({
      label: 'Duplikat-Namen',
      entries: [
        put(dir, 'dup1.bin', randomBytes(10), 'bild.png'),
        put(dir, 'dup2.bin', randomBytes(10), 'bild.png'),
        put(dir, 'dup3.bin', randomBytes(10), '..\\..\\bild.png')
      ]
    })

    for (const c of cases) {
      const predicted = zipSize(c.entries)
      const actual = (await collect(c.entries)).length
      assert.equal(actual, predicted, `${c.label}: zipSize ${predicted} != Stream ${actual}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// -------------------------------------------------------- 3. Bit-Identität

const LOCAL_SIG = 0x04034b50
const DD_SIG = 0x08074b50

/**
 * Mini-Parser im Test: liest die lokalen Header + Data Descriptors der Reihe
 * nach (also genau den Weg, den ein streamender Entpacker geht).
 */
function parseLocal(zip: Buffer): Array<{ name: string; data: Buffer; crc: number }> {
  const out: Array<{ name: string; data: Buffer; crc: number }> = []
  let p = 0
  while (p + 30 <= zip.length && zip.readUInt32LE(p) === LOCAL_SIG) {
    const flags = zip.readUInt16LE(p + 6)
    assert.equal(flags & 0x0008, 0x0008, 'Bit 3 (Data Descriptor) muss gesetzt sein')
    assert.equal(flags & 0x0800, 0x0800, 'Bit 11 (UTF-8) muss gesetzt sein')
    assert.equal(zip.readUInt16LE(p + 8), 0, 'Methode muss 0 (stored) sein')
    const nameLen = zip.readUInt16LE(p + 26)
    const extraLen = zip.readUInt16LE(p + 28)
    const name = zip.subarray(p + 30, p + 30 + nameLen).toString('utf8')
    const dataStart = p + 30 + nameLen + extraLen

    // Größen stehen erst im Data Descriptor -> nächste DD-Signatur suchen und
    // über die dort genannte Länge verifizieren.
    let dd = dataStart
    for (;;) {
      dd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), dd)
      assert.ok(dd >= 0, 'Data Descriptor nicht gefunden')
      assert.equal(zip.readUInt32LE(dd), DD_SIG)
      const size = zip.readUInt32LE(dd + 12)
      if (dd - dataStart === size) break
      dd += 4
    }
    const crc = zip.readUInt32LE(dd + 4)
    out.push({ name, data: zip.subarray(dataStart, dd), crc })
    p = dd + 16
  }
  return out
}

test('Bit-Identität: Inhalte kommen unverändert wieder heraus (lokale Header)', async () => {
  const dir = makeTmpDir()
  try {
    const big = randomBytes(3 * 1024 * 1024 + 123) // mehrere Stream-Chunks
    const originals = [
      { name: 'gross.bin', data: big },
      { name: 'klein.txt', data: Buffer.from('Hallo, Wörld! ÄÖÜ ß', 'utf8') },
      { name: 'leer.dat', data: Buffer.alloc(0) },
      { name: 'Größe & Maß.txt', data: randomBytes(4096) }
    ]
    const entries = originals.map((o, i) => put(dir, `src-${i}.bin`, o.data, o.name))
    const zip = await collect(entries)
    assert.equal(zip.length, zipSize(entries))

    const parsed = parseLocal(zip)
    assert.equal(parsed.length, originals.length)
    for (let i = 0; i < originals.length; i++) {
      assert.equal(parsed[i].name, originals[i].name)
      assert.equal(parsed[i].data.length, originals[i].data.length)
      assert.ok(parsed[i].data.equals(originals[i].data), `Bytes von ${originals[i].name}`)
      assert.equal(parsed[i].crc, crc32(originals[i].data), `CRC von ${originals[i].name}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Bit-Identität: das Inhaltsverzeichnis liest src/main/zip.ts sauber', async () => {
  const dir = makeTmpDir()
  try {
    const originals = [
      { name: 'eins.bin', data: randomBytes(12345) },
      { name: 'Größe.txt', data: Buffer.from('äöü', 'utf8') },
      { name: 'leer.dat', data: Buffer.alloc(0) }
    ]
    const entries = originals.map((o, i) => put(dir, `cd-${i}.bin`, o.data, o.name))
    const zipPath = join(dir, 'out.zip')
    writeFileSync(zipPath, await collect(entries))

    const listed = await listZipEntries(zipPath)
    assert.ok(listed, 'zip.ts muss das Archiv lesen können')
    assert.equal(listed!.total, originals.length)
    assert.deepEqual(
      listed!.entries.map((e) => ({ path: e.path, size: e.size, dir: e.dir })),
      originals.map((o) => ({ path: o.name, size: o.data.length, dir: false }))
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------- 4. CRC32

test('CRC32 stimmt mit den bekannten Referenzwerten überein', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0x00000000)
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32(Buffer.from('a')), 0xe8b7be43)
  assert.equal(crc32(Buffer.from('abc')), 0x352441c2)
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339)
})

// -------------------------------------------------- 5. Echter Entpacker

test('PowerShell Expand-Archive entpackt das Archiv bit-identisch', async (t) => {
  const probe = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'if (Get-Command Expand-Archive) { "ok" }'],
    { encoding: 'utf8' }
  )
  if (probe.status !== 0 || !String(probe.stdout).includes('ok')) {
    t.skip('Expand-Archive in dieser Umgebung nicht verfügbar')
    return
  }

  const dir = makeTmpDir()
  try {
    const originals = [
      { name: 'daten.bin', data: randomBytes(500000) },
      { name: 'Größenübersicht.txt', data: Buffer.from('Ärger mit Umlauten: äöüß', 'utf8') },
      { name: 'leer.dat', data: Buffer.alloc(0) }
    ]
    const entries = originals.map((o, i) => put(dir, `pw-${i}.bin`, o.data, o.name))
    const zipPath = join(dir, 'test.zip')
    writeFileSync(zipPath, await collect(entries))

    const outDir = join(dir, 'entpackt')
    const res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force`
      ],
      { encoding: 'utf8' }
    )
    assert.equal(res.status, 0, `Expand-Archive fehlgeschlagen: ${res.stderr}`)

    const files = readdirSync(outDir).sort()
    assert.deepEqual(files, originals.map((o) => o.name).sort())
    for (const o of originals) {
      const got = readFileSync(join(outDir, o.name))
      assert.ok(got.equals(o.data), `entpackte Bytes von ${o.name} weichen ab`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------- 6. Fehlerfall

test('fehlende Quelldatei: Stream meldet error und hängt nicht', async () => {
  const dir = makeTmpDir()
  try {
    const ok = put(dir, 'da.bin', randomBytes(100))
    const missing: ZipEntry = { name: 'weg.bin', path: join(dir, 'gibtsnicht.bin'), size: 42 }
    const stream = createZipStream([ok, missing])

    const err = await new Promise<Error | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000)
      stream.on('data', () => {})
      stream.on('error', (e: Error) => {
        clearTimeout(timer)
        resolve(e)
      })
      stream.on('end', () => {
        clearTimeout(timer)
        resolve(null)
      })
    })
    assert.ok(err instanceof Error, 'es muss ein error-Event kommen (kein end, kein Hänger)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zu kurze Quelldatei: Stream meldet error, statt die Content-Length zu brechen', async () => {
  const dir = makeTmpDir()
  try {
    const short = put(dir, 'kurz.bin', randomBytes(10))
    short.size = 5000 // gelogene Größe
    const stream = createZipStream([short])

    const err = await new Promise<Error | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000)
      stream.on('data', () => {})
      stream.on('error', (e: Error) => {
        clearTimeout(timer)
        resolve(e)
      })
      stream.on('end', () => {
        clearTimeout(timer)
        resolve(null)
      })
    })
    assert.ok(err instanceof Error)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ 7. ZIP64

test('needsZip64: Layout-Entscheidung allein aus den Eintragsgrößen', () => {
  const e = (name: string, size: number): ZipEntry => ({ name, path: '/nicht/gelesen', size })

  assert.equal(needsZip64([]), false)
  assert.equal(needsZip64([e('a.bin', 10)]), false)

  // Einzelne Datei >= 4 GiB: 0xffffffff ist der Sentinel-Wert -> ab da ZIP64.
  assert.equal(needsZip64([e('a.bin', 0xffffffff)]), true)
  assert.equal(needsZip64([e('a.bin', 5 * 1024 ** 3)]), true)

  // Exakte Grenze über die Gesamtgröße: lokaler Header 30 + 5 (Name) + Daten +
  // 16 (Data Descriptor), Verzeichnis 46 + 5, EOCD 22 -> 124 Byte Beiwerk.
  const passtGerade = 0xffffffff - 124
  assert.equal(needsZip64([e('a.bin', passtGerade - 1)]), false)
  assert.equal(needsZip64([e('a.bin', passtGerade)]), true)

  // Summe sprengt 4 GiB, obwohl jede Datei allein passt.
  const half = 0x90000000 // 2,25 GiB
  assert.equal(needsZip64([e('a.bin', half), e('b.bin', half)]), true)

  // Viele Einträge: ab 65535 geht das uint16-Feld im EOCD nicht mehr.
  const many = (n: number): ZipEntry[] =>
    Array.from({ length: n }, (_, i) => e(`f-${i}.bin`, 0))
  assert.equal(needsZip64(many(1000)), false)
  assert.equal(needsZip64(many(0xffff)), true)
})

test('ZIP64-Layout: zipSize und Stream bleiben auch im ZIP64-Modus deckungsgleich', async () => {
  // Kein 4-GiB-Durchlauf (unverhältnismäßig) – aber über die Eintragszahl lässt
  // sich der ZIP64-Zweig echt durchlaufen: 65535 Einträge à 0 Byte.
  const dir = makeTmpDir()
  try {
    const path = join(dir, 'leer.bin')
    writeFileSync(path, Buffer.alloc(0))
    const entries: ZipEntry[] = Array.from({ length: 0xffff }, (_, i) => ({
      name: `f-${i}.bin`,
      path,
      size: 0
    }))
    assert.equal(needsZip64(entries), true)

    const predicted = zipSize(entries)
    const zip = await collect(entries)
    assert.equal(zip.length, predicted)

    // ZIP64-EOCD + Locator müssen am Ende stehen, das klassische EOCD auf
    // Sentinel-Werten.
    const eocd = zip.length - 22
    assert.equal(zip.readUInt32LE(eocd), 0x06054b50)
    assert.equal(zip.readUInt16LE(eocd + 10), 0xffff)
    assert.equal(zip.readUInt32LE(eocd + 16), 0xffffffff)
    assert.equal(zip.readUInt32LE(eocd - 20), 0x07064b50, 'ZIP64-Locator')
    assert.equal(zip.readUInt32LE(eocd - 20 - 56), 0x06064b50, 'ZIP64-EOCD')

    // Der ZIP64-Locator muss auf den ZIP64-EOCD zeigen.
    const locOffset = Number(zip.readBigUInt64LE(eocd - 20 + 8))
    assert.equal(locOffset, eocd - 20 - 56)
    assert.equal(Number(zip.readBigUInt64LE(eocd - 20 - 56 + 32)), entries.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nicht-ZIP64-Archive tragen kein ZIP64-Beiwerk', async () => {
  const dir = makeTmpDir()
  try {
    const entries = [put(dir, 'x.bin', randomBytes(64))]
    const zip = await collect(entries)
    assert.equal(zip.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])), -1, 'kein ZIP64-EOCD')
    assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 1)
    assert.equal(zip.readUInt16LE(26 + 2), 0, 'kein Extra-Feld im lokalen Header')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------- 8. Aufräum-Sicherheit

test('Temp-Ordner der Tests werden wieder gelöscht', () => {
  const dir = makeTmpDir()
  rmSync(dir, { recursive: true, force: true })
  assert.equal(existsSync(dir), false)
})
