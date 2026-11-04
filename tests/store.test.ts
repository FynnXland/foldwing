import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ShareStore, BUNDLE_MIME, isBundle, bundleFile, ShareMeta } from '../src/main/store'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'foldwing-store-test-'))
}

test('begin/write/finalize: Roundtrip ist bit-identisch zu den geschriebenen Bytes', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const original = randomBytes(1024 * 64 + 7) // krumme Größe, mehrere Chunks
    const id = store.begin('original.bin', 'application/octet-stream')

    // In mehreren Chunks schreiben, wie es ein echter Upload-Stream tun würde.
    const chunkSize = 8192
    for (let offset = 0; offset < original.length; offset += chunkSize) {
      const ok = await store.write(id, original.subarray(offset, offset + chunkSize))
      assert.equal(ok, true, 'write() sollte für gültige id/dataDir true liefern')
    }

    const meta = await store.finalize(id)
    assert.ok(meta)
    assert.equal(meta!.size, original.length)
    assert.equal(meta!.mime, 'application/octet-stream')

    const written = readFileSync(store.binPath(id))
    assert.deepEqual(written, original, 'gespeicherte Bytes müssen exakt den Original-Bytes entsprechen')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanFileName-Effekt: Steuerzeichen raus, Länge begrenzt, Leerstring -> "datei"', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()

    const id1 = store.begin('mit\u0000Steuerzeichen\u001f.txt', 'text/plain')
    await store.write(id1, Buffer.from('x'))
    const meta1 = await store.finalize(id1)
    assert.ok(meta1)
    assert.equal(meta1!.name, 'mitSteuerzeichen.txt')

    const longName = 'a'.repeat(500) + '.txt'
    const id2 = store.begin(longName, 'text/plain')
    await store.write(id2, Buffer.from('x'))
    const meta2 = await store.finalize(id2)
    assert.ok(meta2)
    assert.equal(meta2!.name.length, 200)

    const id3 = store.begin('   ', 'text/plain')
    await store.write(id3, Buffer.from('x'))
    const meta3 = await store.finalize(id3)
    assert.ok(meta3)
    assert.equal(meta3!.name, 'datei')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setExpiry: setzt und entfernt den Ablaufzeitpunkt', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const id = store.begin('a.txt', 'text/plain')
    await store.write(id, Buffer.from('hallo'))
    await store.finalize(id)

    const future = Date.now() + 100_000
    const withExpiry = await store.setExpiry(id, future)
    assert.ok(withExpiry)
    assert.equal(withExpiry!.expiresAt, future)

    // Auf der Platte persistiert, nicht nur im Rückgabewert.
    const reread = await store.get(id)
    assert.equal(reread!.expiresAt, future)

    const permanent = await store.setExpiry(id, null)
    assert.ok(permanent)
    assert.equal(permanent!.expiresAt, undefined)
    const rereadPermanent = await store.get(id)
    assert.equal(rereadPermanent!.expiresAt, undefined)

    const missing = await store.setExpiry('nicht-vorhanden', future)
    assert.equal(missing, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sweepExpired: entfernt nur abgelaufene Freigaben und gibt ihre IDs zurück', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()

    const expiredId = store.begin('alt.txt', 'text/plain')
    await store.write(expiredId, Buffer.from('alt'))
    await store.finalize(expiredId, Date.now() - 1000) // schon abgelaufen

    const freshId = store.begin('neu.txt', 'text/plain')
    await store.write(freshId, Buffer.from('neu'))
    await store.finalize(freshId)

    const removed = await store.sweepExpired()
    assert.deepEqual(removed, [expiredId])

    assert.equal(await store.get(expiredId), null)
    assert.ok(await store.get(freshId))
    assert.equal(existsSync(store.binPath(expiredId)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remove: löscht Rohdaten und Metadatei', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const id = store.begin('weg.txt', 'text/plain')
    await store.write(id, Buffer.from('weg'))
    await store.finalize(id)

    assert.ok(existsSync(store.binPath(id)))
    await store.remove(id)
    assert.equal(existsSync(store.binPath(id)), false)
    assert.equal(await store.get(id), null)

    // Zweiter remove() auf eine bereits entfernte id darf nicht werfen.
    await store.remove(id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('list: absteigend nach createdAt sortiert', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()

    const idOld = store.begin('alt.txt', 'text/plain')
    await store.write(idOld, Buffer.from('a'))
    await store.finalize(idOld)
    const idNew = store.begin('neu.txt', 'text/plain')
    await store.write(idNew, Buffer.from('b'))
    await store.finalize(idNew)

    // createdAt liegt bei finalize() nur Millisekunden auseinander (evtl. sogar
    // identisch) -> für einen zuverlässigen Sortiertest die Metadatei direkt
    // überschreiben (bekannte Ablage-Struktur: "<id>.json" im dataDir).
    const metaPath = (id: string): string => join(dir, `${id}.json`)
    const oldMeta = JSON.parse(readFileSync(metaPath(idOld), 'utf-8'))
    oldMeta.createdAt = 1000
    writeFileSync(metaPath(idOld), JSON.stringify(oldMeta))
    const newMeta = JSON.parse(readFileSync(metaPath(idNew), 'utf-8'))
    newMeta.createdAt = 2000
    writeFileSync(metaPath(idNew), JSON.stringify(newMeta))

    const list = await store.list()
    assert.deepEqual(
      list.map((m) => m.id),
      [idNew, idOld]
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'Fehlerpfad: write() liefert false und finalize() null bei nicht existierendem dataDir',
  { timeout: 10_000 },
  async () => {
    const missingDir = join(tmpdir(), 'foldwing-store-test-missing-' + Date.now() + '-' + process.pid)
    assert.equal(existsSync(missingDir), false)
    const store = new ShareStore(missingDir) // bewusst KEIN store.init() -> Ordner existiert nicht

    const id = store.begin('a.txt', 'text/plain')
    // createWriteStream() öffnet die Datei asynchron (fs.open) – der ENOENT-Fehler
    // (Ordner existiert nicht) kommt erst kurz später als 'error'-Event auf dem
    // Stream an. Ein einzelner sofortiger write()-Aufruf kann daher noch VOR dem
    // Fehler durchlaufen (kein Backpressure -> stream.write() liefert true, bevor
    // p.error gesetzt ist). Kurz warten, bis der Fehler garantiert angekommen ist,
    // dann erst prüfen – kein Hängen, da der Timeout des Tests greifen würde.
    await new Promise((resolve) => setTimeout(resolve, 200))

    const ok = await store.write(id, Buffer.from('hallo'))
    assert.equal(ok, false)

    const meta = await store.finalize(id)
    assert.equal(meta, null)
  }
)

// ---------------------------------------------------------------------------
// Sammlungen (mehrere Dateien in EINER Freigabe)
// ---------------------------------------------------------------------------

/** Datei in Chunks in einen offenen Upload schreiben. */
async function writeAll(store: ShareStore, uploadId: string, data: Buffer): Promise<void> {
  const chunkSize = 8192
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const ok = await store.write(uploadId, data.subarray(offset, offset + chunkSize))
    assert.equal(ok, true, 'write() sollte für einen offenen Sammlungs-Upload true liefern')
  }
}

test('beginBundle/finalizeBundle: 3 Dateien, bit-identisch, Reihenfolge und Summe stimmen', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()

    const inputs = [
      { name: 'eins.txt', mime: 'text/plain', data: Buffer.from('Hallo Welt') },
      // ~2 MB, damit die Backpressure-Schleife (drain) wirklich greift.
      { name: 'zwei.bin', mime: 'application/octet-stream', data: randomBytes(2 * 1024 * 1024 + 13) },
      { name: 'drei.png', mime: 'image/png', data: randomBytes(4096) }
    ]

    const { id, uploads } = store.beginBundle(inputs.map((f) => ({ name: f.name, mime: f.mime })))
    assert.equal(uploads.length, 3)
    for (let i = 0; i < inputs.length; i++) await writeAll(store, uploads[i].uploadId, inputs[i].data)

    const meta = await store.finalizeBundle(id)
    assert.ok(meta)
    assert.equal(meta!.id, id)
    assert.equal(meta!.mime, BUNDLE_MIME)
    assert.equal(meta!.name, '3 Dateien')
    assert.equal(isBundle(meta!), true)
    assert.equal(meta!.files!.length, 3)
    assert.equal(
      meta!.size,
      inputs.reduce((s, f) => s + f.data.length, 0)
    )

    // Reihenfolge wie übergeben, fids eindeutig.
    assert.deepEqual(
      meta!.files!.map((f) => f.name),
      ['eins.txt', 'zwei.bin', 'drei.png']
    )
    assert.deepEqual(
      meta!.files!.map((f) => f.fid),
      uploads.map((u) => u.fid)
    )
    assert.equal(new Set(meta!.files!.map((f) => f.fid)).size, 3)

    // Jede Teildatei auf der Platte muss bit-identisch zum Original sein.
    for (let i = 0; i < inputs.length; i++) {
      const f = meta!.files![i]
      assert.equal(f.size, inputs[i].data.length)
      assert.equal(f.mime, inputs[i].mime)
      const onDisk = readFileSync(store.binPath(id, f.fid))
      assert.deepEqual(onDisk, inputs[i].data, `Teildatei ${f.name} muss bit-identisch sein`)
    }

    // Auch nach dem Neulesen von der Platte.
    const reread = await store.get(id)
    assert.equal(isBundle(reread!), true)
    assert.equal(reread!.files!.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finalizeBundle: eine einzelne Datei heißt "1 Datei"', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const { id, uploads } = store.beginBundle([{ name: 'allein.txt', mime: 'text/plain' }])
    await writeAll(store, uploads[0].uploadId, Buffer.from('x'))
    const meta = await store.finalizeBundle(id)
    assert.ok(meta)
    assert.equal(meta!.name, '1 Datei')
    assert.equal(meta!.mime, BUNDLE_MIME)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isBundle/bundleFile: unbekannte fid -> null, Einzeldatei ist keine Sammlung', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()

    const { id, uploads } = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' }
    ])
    await writeAll(store, uploads[0].uploadId, Buffer.from('aa'))
    await writeAll(store, uploads[1].uploadId, Buffer.from('bbb'))
    const bundle = await store.finalizeBundle(id)
    assert.ok(bundle)

    const found = bundleFile(bundle!, uploads[1].fid)
    assert.ok(found)
    assert.equal(found!.name, 'b.txt')
    assert.equal(found!.size, 3)
    assert.equal(bundleFile(bundle!, 'gibtsnicht'), null)
    assert.equal(bundleFile(bundle!, ''), null)

    const singleId = store.begin('einzeln.txt', 'text/plain')
    await store.write(singleId, Buffer.from('x'))
    const single = await store.finalize(singleId)
    assert.ok(single)
    assert.equal(isBundle(single!), false)
    assert.equal(bundleFile(single!, 'egal'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Altbestand: Metadatei ohne files[] bleibt eine normale Einzeldatei', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()

    // Metadatei im ALTEN Format direkt ins Verzeichnis schreiben.
    const id = 'AltBestand1'
    const bytes = Buffer.from('alte Daten')
    writeFileSync(join(dir, `${id}.bin`), bytes)
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        name: 'alt.txt',
        mime: 'text/plain',
        size: bytes.length,
        createdAt: 1000
      })
    )

    const meta = await store.get(id)
    assert.ok(meta)
    assert.equal(meta!.name, 'alt.txt')
    assert.equal(meta!.size, bytes.length)
    assert.equal(isBundle(meta!), false)
    assert.equal(meta!.files, undefined)
    assert.equal(store.binPath(id), join(dir, `${id}.bin`))
    assert.deepEqual(readFileSync(store.binPath(id)), bytes)

    // list() findet sie ebenfalls, remove() räumt sie restlos weg.
    assert.ok((await store.list()).some((m) => m.id === id))
    await store.remove(id)
    assert.equal(existsSync(join(dir, `${id}.bin`)), false)
    assert.equal(existsSync(join(dir, `${id}.json`)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remove: Sammlung verschwindet mitsamt allen Teildateien', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const { id, uploads } = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' },
      { name: 'c.txt', mime: 'text/plain' }
    ])
    for (const u of uploads) await writeAll(store, u.uploadId, Buffer.from('inhalt'))
    const meta = await store.finalizeBundle(id)
    assert.ok(meta)
    for (const f of meta!.files!) assert.ok(existsSync(store.binPath(id, f.fid)))

    await store.remove(id)
    assert.equal(await store.get(id), null)
    assert.deepEqual(readdirSync(dir), [], 'nach remove() darf nichts liegen bleiben')

    // Zweiter remove() darf nicht werfen.
    await store.remove(id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remove: fehlende Metadatei -> Teildateien werden trotzdem entfernt', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const { id, uploads } = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' }
    ])
    for (const u of uploads) await writeAll(store, u.uploadId, Buffer.from('inhalt'))
    const meta = await store.finalizeBundle(id)
    assert.ok(meta)

    // Metadatei hinter dem Rücken des Stores löschen (Absturz-Szenario).
    rmSync(join(dir, `${id}.json`), { force: true })
    assert.equal(readdirSync(dir).length, 2)

    await store.remove(id)
    assert.deepEqual(readdirSync(dir), [], 'Teildateien dürfen ohne Metadatei nicht liegen bleiben')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sweepExpired: abgelaufene Sammlung wird restlos entfernt', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const { id, uploads } = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' }
    ])
    for (const u of uploads) await writeAll(store, u.uploadId, Buffer.from('weg damit'))
    const meta = await store.finalizeBundle(id, Date.now() - 1000)
    assert.ok(meta)
    assert.equal(readdirSync(dir).length, 3) // 2 Teildateien + Metadatei

    const removed = await store.sweepExpired()
    assert.deepEqual(removed, [id])
    assert.equal(await store.get(id), null)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('abortBundle: Teildateien weg, finalizeBundle danach null, mehrfach aufrufbar', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const { id, uploads } = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' }
    ])
    for (const u of uploads) await writeAll(store, u.uploadId, Buffer.from('halbfertig'))

    await store.abortBundle(id)
    assert.deepEqual(readdirSync(dir), [], 'abortBundle() muss alle Teildateien löschen')
    assert.equal(await store.finalizeBundle(id), null)
    assert.equal(await store.get(id), null)

    // Idempotent: zweimal abbrechen, auch für eine unbekannte ID.
    await store.abortBundle(id)
    await store.abortBundle('gibtsnicht')

    // Schreiben auf einen abgebrochenen Upload schlägt sauber fehl.
    assert.equal(await store.write(uploads[0].uploadId, Buffer.from('x')), false)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('beginBundle([]) wirft', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    assert.throws(() => store.beginBundle([]), /Keine Dateien/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setExpiry auf eine Sammlung lässt files[] unangetastet', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const { id, uploads } = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' }
    ])
    for (const u of uploads) await writeAll(store, u.uploadId, Buffer.from('bleibt'))
    const meta = await store.finalizeBundle(id)
    assert.ok(meta)

    const future = Date.now() + 100_000
    const withExpiry = await store.setExpiry(id, future)
    assert.ok(withExpiry)
    assert.equal(withExpiry!.expiresAt, future)
    assert.deepEqual(withExpiry!.files, meta!.files)

    const reread = await store.get(id)
    assert.equal(isBundle(reread!), true)
    assert.deepEqual(reread!.files, meta!.files)
    assert.equal(reread!.mime, BUNDLE_MIME)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'Fehlerpfad Sammlung: nicht existierendes dataDir -> finalizeBundle null, keine Leichen',
  { timeout: 10_000 },
  async () => {
    const missingDir = join(
      tmpdir(),
      'foldwing-store-test-bundle-missing-' + Date.now() + '-' + process.pid
    )
    assert.equal(existsSync(missingDir), false)
    const store = new ShareStore(missingDir) // bewusst KEIN init() -> Ordner fehlt

    // Unbehandelte Rejections während des Tests einsammeln.
    const stray: unknown[] = []
    const onStray = (e: unknown): void => {
      stray.push(e)
    }
    process.on('unhandledRejection', onStray)
    try {
      const { id, uploads } = store.beginBundle([
        { name: 'a.txt', mime: 'text/plain' },
        { name: 'b.txt', mime: 'text/plain' }
      ])
      // Der ENOENT kommt asynchron auf den Streams an (siehe Einzeldatei-Test).
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(await store.write(uploads[0].uploadId, Buffer.from('hallo')), false)

      const meta = await store.finalizeBundle(id)
      assert.equal(meta, null)
      assert.equal(existsSync(missingDir), false, 'es darf gar nichts angelegt worden sein')

      // Aufräumen wirft auch hier nicht.
      await store.abortBundle(id)
      await store.remove(id)
    } finally {
      process.off('unhandledRejection', onStray)
    }
    assert.deepEqual(stray, [], 'kein unbehandelter Fehler im Prozess')
  }
)

test('finalizeBundle: fällt ein Teil aus, entsteht keine halbe Freigabe', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const { id, uploads } = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' }
    ])
    for (const u of uploads) await writeAll(store, u.uploadId, Buffer.from('inhalt'))

    // Einen Teil-Upload einzeln abbrechen -> Sammlung ist unvollständig.
    await store.abort(uploads[1].uploadId)

    const meta = await store.finalizeBundle(id)
    assert.equal(meta, null)
    assert.deepEqual(readdirSync(dir), [], 'keine Teildatei und keine Metadatei zurücklassen')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Sammlung und Einzeldatei nebeneinander: list() liefert beide unversehrt', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()

    const singleId = store.begin('einzeln.txt', 'text/plain')
    await store.write(singleId, Buffer.from('nur ich'))
    const single = await store.finalize(singleId)
    assert.ok(single)
    // Einzeldateien liegen weiterhin unter <id>.bin (Altbestands-Layout).
    assert.equal(store.binPath(singleId), join(dir, `${singleId}.bin`))

    const { id, uploads } = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' }
    ])
    for (const u of uploads) await writeAll(store, u.uploadId, Buffer.from('zwei'))
    assert.ok(await store.finalizeBundle(id))

    const list: ShareMeta[] = await store.list()
    assert.equal(list.length, 2)
    assert.equal(list.filter((m) => isBundle(m)).length, 1)

    // Die Sammlung löschen darf die Einzeldatei nicht anfassen.
    await store.remove(id)
    assert.ok(existsSync(store.binPath(singleId)))
    assert.ok(await store.get(singleId))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Offene Uploads (Grundlage für „Teilen nach Bedarf" und das Freigeben des Fensters)
// ---------------------------------------------------------------------------

test('hasPendingUploads: Einzeldatei von begin bis finalize bzw. abort', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    assert.equal(store.hasPendingUploads(), false)

    const id = store.begin('a.txt', 'text/plain')
    assert.equal(store.hasPendingUploads(), true)
    await store.write(id, Buffer.from('x'))
    assert.equal(store.hasPendingUploads(), true)
    assert.ok(await store.finalize(id))
    assert.equal(store.hasPendingUploads(), false)

    const aborted = store.begin('b.txt', 'text/plain')
    assert.equal(store.hasPendingUploads(), true)
    await store.abort(aborted)
    assert.equal(store.hasPendingUploads(), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hasPendingUploads: Sammlung bleibt offen, bis sie abgeschlossen oder verworfen ist', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()

    const done = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' }
    ])
    for (const u of done.uploads) await writeAll(store, u.uploadId, Buffer.from('inhalt'))
    assert.equal(store.hasPendingUploads(), true)
    assert.ok(await store.finalizeBundle(done.id))
    assert.equal(store.hasPendingUploads(), false)

    // Ein einzeln abgebrochener Teil schließt die Sammlung noch nicht ab.
    const broken = store.beginBundle([
      { name: 'a.txt', mime: 'text/plain' },
      { name: 'b.txt', mime: 'text/plain' }
    ])
    await store.abort(broken.uploads[0].uploadId)
    await store.abort(broken.uploads[1].uploadId)
    assert.equal(store.hasPendingUploads(), true)
    await store.abortBundle(broken.id)
    assert.equal(store.hasPendingUploads(), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hasPendingUploads: Schreibfehler räumt den Upload ab', { timeout: 10_000 }, async () => {
  const missingDir = join(tmpdir(), 'foldwing-store-test-pending-' + Date.now() + '-' + process.pid)
  const store = new ShareStore(missingDir) // bewusst KEIN init() -> Schreiben scheitert
  const id = store.begin('a.txt', 'text/plain')
  await new Promise((resolve) => setTimeout(resolve, 200)) // ENOENT kommt asynchron
  assert.equal(await store.write(id, Buffer.from('x')), false)
  assert.equal(store.hasPendingUploads(), false)
})

test('abortStaleUploads: ohne Lebenszeichen über die Frist -> verworfen, vorher nicht', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const id = store.begin('verwaist.txt', 'text/plain')
    await store.write(id, Buffer.from('halb'))
    const t0 = Date.now() // letztes Lebenszeichen liegt bei <= t0

    // Gerade frisch (echte Uhr) und innerhalb der Frist passiert nichts.
    assert.deepEqual(await store.abortStaleUploads(60_000), [])
    assert.deepEqual(await store.abortStaleUploads(60_000, t0 + 59_000), [])
    assert.equal(store.hasPendingUploads(), true)

    // Über der Frist: Upload weg, angefangene Datei weg, nichts mehr anzuhängen.
    assert.deepEqual(await store.abortStaleUploads(60_000, t0 + 61_000), [id])
    assert.equal(store.hasPendingUploads(), false)
    assert.equal(existsSync(store.binPath(id)), false, 'angefangene Datei muss weg sein')
    assert.equal(await store.finalize(id), null)
    assert.equal(await store.write(id, Buffer.from('x')), false)

    // Nichts mehr offen -> nichts zu tun.
    assert.deepEqual(await store.abortStaleUploads(0, t0 + 999_999), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('abortStaleUploads: Schreiben hält einen Upload am Leben', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const id = store.begin('lang.bin', 'application/octet-stream')
    const start = Date.now()
    // Kurz warten, dann schreiben: das Lebenszeichen rückt nach vorn.
    await new Promise((resolve) => setTimeout(resolve, 30))
    await store.write(id, Buffer.from('noch da'))
    const lastWrite = Date.now()
    assert.ok(lastWrite > start)
    // Gemessen ab dem Anlegen wäre die Frist um, ab dem Schreiben nicht.
    assert.deepEqual(await store.abortStaleUploads(lastWrite - start, lastWrite + 1), [])
    assert.equal(store.hasPendingUploads(), true)
    assert.ok(await store.finalize(id))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('abortStaleUploads: Sammlung zählt als Ganzes, verwaist wird sie komplett verworfen', async () => {
  const dir = makeTmpDir()
  try {
    const store = new ShareStore(dir)
    await store.init()
    const { id, uploads } = store.beginBundle([
      { name: 'a.bin', mime: 'application/octet-stream' },
      { name: 'b.bin', mime: 'application/octet-stream' }
    ])
    const opened = Date.now()
    // Nur der erste Teil bekommt Daten – der zweite wartet (Teile laufen nacheinander).
    await new Promise((resolve) => setTimeout(resolve, 300))
    await writeAll(store, uploads[0].uploadId, Buffer.from('erster teil'))
    const lastWrite = Date.now()

    // Gemessen ab dem Anlegen wäre der zweite Teil über der Frist (>= 400 ms > 200 ms),
    // die Sammlung als Ganzes hat aber gerade erst geschrieben.
    const check = lastWrite + 100
    assert.ok(check - opened > 200)
    assert.deepEqual(await store.abortStaleUploads(200, check), [])
    assert.equal(store.hasPendingUploads(), true)

    // Ohne weiteres Lebenszeichen: die ganze Sammlung samt Teildateien verwerfen.
    assert.deepEqual(await store.abortStaleUploads(200, lastWrite + 60_000), [id])
    assert.equal(store.hasPendingUploads(), false)
    assert.deepEqual(readdirSync(dir), [], 'keine Teildatei darf liegen bleiben')
    assert.equal(await store.finalizeBundle(id), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
