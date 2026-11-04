import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { ShareStore } from '../src/main/store'
import { startServer, type ServerHandle, type ServerHooks } from '../src/main/server'

/** Eigene Geräte-ID im Test (8 Zeichen base62). */
const DEVICE = 'TestDev1'

/** Minimale Hooks für den Server-Test. */
function makeHooks(extra: Partial<ServerHooks> = {}): ServerHooks {
  return {
    deviceId: () => DEVICE,
    ...extra
  }
}

async function withServer(
  fn: (handle: ServerHandle, store: ShareStore, dir: string) => Promise<void>,
  hooks: Partial<ServerHooks> = {}
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'foldwing-server-test-'))
  const store = new ShareStore(dir)
  await store.init()
  const handle = await startServer(store, 0, makeHooks(hooks))
  try {
    await fn(handle, store, dir)
  } finally {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

function request(
  port: number,
  path: string,
  options: http.RequestOptions = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', ...options }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      )
    })
    req.on('error', reject)
    req.end()
  })
}

test('GET /api/health -> 200 { ok, app, device }', async () => {
  await withServer(async (handle) => {
    const res = await request(handle.port, '/api/health')
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body.toString('utf-8')), { ok: true, app: 'Foldwing', device: DEVICE })
  })
  // Ohne Geräte-ID: device ist null.
  await withServer(
    async (handle) => {
      const res = await request(handle.port, '/api/health')
      assert.deepEqual(JSON.parse(res.body.toString('utf-8')), { ok: true, app: 'Foldwing', device: null })
    },
    { deviceId: () => null }
  )
})

test('GET /s/<id>: 200, CSP script-src none, unbekannte id -> 404', async () => {
  await withServer(async (handle, store) => {
    const id = store.begin('bild.png', 'image/png')
    await store.write(id, Buffer.from('fake-png-bytes'))
    await store.finalize(id)

    const res = await request(handle.port, `/s/${id}`)
    assert.equal(res.status, 200)
    const csp = res.headers['content-security-policy']
    assert.ok(csp)
    assert.match(String(csp), /script-src 'none'/)

    const missing = await request(handle.port, '/s/does-not-exist')
    assert.equal(missing.status, 404)
  })
})

test('GET /f/<id>: 200 mit Content-Length, unbekannte id -> 404', async () => {
  await withServer(async (handle, store) => {
    const content = Buffer.from('hallo welt, dies ist der dateiinhalt')
    const id = store.begin('text.txt', 'text/plain')
    await store.write(id, content)
    await store.finalize(id)

    const res = await request(handle.port, `/f/${id}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-length'], String(content.length))
    assert.deepEqual(res.body, content)

    const missing = await request(handle.port, '/f/does-not-exist')
    assert.equal(missing.status, 404)
  })
})

test('GET /f/<id> mit Range bytes=0-3 -> 206 + Content-Range', async () => {
  await withServer(async (handle, store) => {
    const content = Buffer.from('0123456789')
    const id = store.begin('zahlen.txt', 'text/plain')
    await store.write(id, content)
    await store.finalize(id)

    const res = await request(handle.port, `/f/${id}`, { headers: { Range: 'bytes=0-3' } })
    assert.equal(res.status, 206)
    assert.equal(res.headers['content-range'], `bytes 0-3/${content.length}`)
    assert.equal(res.body.toString('utf-8'), '0123')
  })
})

test('unbekannter Pfad mit Traversal-Versuch (/update/../x) -> 404, kein Absturz', async () => {
  await withServer(async (handle) => {
    const res = await request(handle.port, '/update/../x')
    assert.equal(res.status, 404)
  })
})

test('GET /f/<id> für eine .html-Datei -> Content-Disposition attachment (kein Inline-XSS)', async () => {
  await withServer(async (handle, store) => {
    const id = store.begin('seite.html', 'text/html')
    await store.write(id, Buffer.from('<html><body>hi</body></html>'))
    await store.finalize(id)

    const res = await request(handle.port, `/f/${id}`)
    assert.equal(res.status, 200)
    assert.match(String(res.headers['content-disposition']), /^attachment;/)
  })
})

test('GET /f/<id>: CSP sandbox auf 200 UND 206 (Tiefenverteidigung gegen Direktnavigation)', async () => {
  await withServer(async (handle, store) => {
    const id = store.begin('notiz.txt', 'text/plain')
    await store.write(id, Buffer.from('0123456789'))
    await store.finalize(id)

    const full = await request(handle.port, `/f/${id}`)
    assert.equal(full.status, 200)
    assert.equal(full.headers['content-security-policy'], 'sandbox allow-downloads')

    const partial = await request(handle.port, `/f/${id}`, { headers: { Range: 'bytes=0-3' } })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers['content-security-policy'], 'sandbox allow-downloads')
  })
})

test('GET /f/<id> für ein PDF: KEINE Sandbox-CSP (sonst bliebe die Vorschau leer)', async () => {
  await withServer(async (handle, store) => {
    const id = store.begin('handbuch.pdf', 'application/pdf')
    await store.write(id, Buffer.from('%PDF-1.4 nicht echt'))
    await store.finalize(id)

    const res = await request(handle.port, `/f/${id}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-security-policy'], undefined)
    // Inline bleibt es trotzdem – der Browser-Betrachter soll es zeigen dürfen.
    assert.match(String(res.headers['content-disposition']), /^inline;/)
  })
})

test('/update/… und /impressum gibt es nicht mehr -> 404', async () => {
  await withServer(async (handle) => {
    for (const p of ['/update/latest.yml', '/impressum']) {
      assert.equal((await request(handle.port, p)).status, 404, p)
    }
  })
})

test('GET /s/<id>: Vorschau wird zwischengespeichert (zweiter Aufruf rechnet nicht neu)', async () => {
  await withServer(async (handle, store) => {
    const id = store.begin('notiz.txt', 'text/plain')
    await store.write(id, Buffer.from('ERSTER-INHALT'))
    await store.finalize(id)

    const first = await request(handle.port, `/s/${id}`)
    assert.equal(first.status, 200)
    assert.match(first.body.toString('utf-8'), /ERSTER-INHALT/)

    // Die Datei unter der Freigabe austauschen. Würde buildPreview erneut laufen,
    // stünde jetzt der neue Text auf der Seite – tut er nicht, also kam sie aus
    // dem Zwischenspeicher (kein blockierendes Neuberechnen pro Aufruf).
    writeFileSync(store.binPath(id), 'ZWEITER-INHALT')

    const second = await request(handle.port, `/s/${id}`)
    assert.equal(second.status, 200)
    assert.equal(second.body.toString('utf-8'), first.body.toString('utf-8'))
    assert.doesNotMatch(second.body.toString('utf-8'), /ZWEITER-INHALT/)
  })
})

test('GET /s/<id>: parallele Aufrufe liefern dieselbe Vorschau (Single-Flight)', async () => {
  await withServer(async (handle, store) => {
    const id = store.begin('tabelle.csv', 'text/csv')
    await store.write(id, Buffer.from('a,b\n1,2\n'))
    await store.finalize(id)

    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(handle.port, `/s/${id}`))
    )
    for (const r of results) {
      assert.equal(r.status, 200)
      assert.equal(r.body.toString('utf-8'), results[0].body.toString('utf-8'))
    }
  })
})

/* ------------------------------------------------------------------ */
/* Sammlungen: ein Link, mehrere Dateien                                */
/* ------------------------------------------------------------------ */

interface BundleInput {
  name: string
  mime: string
  data: Buffer
}

/** Sammlung direkt über den Store anlegen (kein IPC im Test nötig). */
async function makeBundle(
  store: ShareStore,
  files: BundleInput[],
  expiresAt?: number
): Promise<{ id: string; fids: string[] }> {
  const { id, uploads } = store.beginBundle(files.map((f) => ({ name: f.name, mime: f.mime })))
  for (let i = 0; i < files.length; i++) {
    assert.equal(await store.write(uploads[i].uploadId, files[i].data), true)
  }
  const meta = await store.finalizeBundle(id, expiresAt)
  assert.ok(meta, 'Sammlung konnte nicht abgeschlossen werden')
  return { id, fids: uploads.map((u) => u.fid) }
}

interface ParsedZipEntry {
  name: string
  size: number
  data: Buffer
}

/**
 * Winziger ZIP-Leser für den Test: liest das zentrale Inhaltsverzeichnis und
 * holt sich zu jedem Eintrag die Rohbytes über den lokalen Header. Bewusst
 * unabhängig vom Schreiber implementiert (Methode 0 = stored, also 1:1).
 */
function parseZip(buf: Buffer): ParsedZipEntry[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, 'kein End-of-Central-Directory gefunden')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  const out: ParsedZipEntry[] = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'kaputter Verzeichnis-Eintrag')
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8')

    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'kaputter lokaler Header')
    const start =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    out.push({ name, size, data: buf.subarray(start, start + size) })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

test('GET /s/<id> einer Sammlung: alle Dateinamen + ZIP-Link, CSP wie gehabt', async () => {
  await withServer(async (handle, store) => {
    const { id } = await makeBundle(store, [
      { name: 'eins.txt', mime: 'text/plain', data: Buffer.from('AAA') },
      { name: 'zwei.txt', mime: 'text/plain', data: Buffer.from('BBB') },
      { name: 'drei.png', mime: 'image/png', data: Buffer.from('fake-png') }
    ])

    const res = await request(handle.port, `/s/${id}`)
    assert.equal(res.status, 200)
    const html = res.body.toString('utf-8')
    assert.match(html, /eins\.txt/)
    assert.match(html, /zwei\.txt/)
    assert.match(html, /drei\.png/)
    assert.match(html, new RegExp(`href="/f/${id}\\?dl=1"`))
    assert.match(html, /Alle als ZIP herunterladen/)
    assert.match(String(res.headers['content-security-policy']), /script-src 'none'/)
  })
})

test('GET /s/<id>/<fid>: Teildatei-Seite; unbekannte fid und Einzeldatei -> 404', async () => {
  await withServer(async (handle, store) => {
    const { id, fids } = await makeBundle(store, [
      { name: 'bericht.txt', mime: 'text/plain', data: Buffer.from('inhalt eins') },
      { name: 'anhang.txt', mime: 'text/plain', data: Buffer.from('inhalt zwei') }
    ])

    const res = await request(handle.port, `/s/${id}/${fids[1]}`)
    assert.equal(res.status, 200)
    const html = res.body.toString('utf-8')
    assert.match(html, /anhang\.txt/)
    assert.match(html, /inhalt zwei/)
    assert.match(html, new RegExp(`href="/s/${id}"`)) // Zurück-Knopf

    const unknown = await request(handle.port, `/s/${id}/ZZZZZZ`)
    assert.equal(unknown.status, 404)

    // Eine klassische Einzeldatei hat keine Teildateien.
    const single = store.begin('solo.txt', 'text/plain')
    await store.write(single, Buffer.from('nur ich'))
    await store.finalize(single)
    const notABundle = await request(handle.port, `/s/${single}/abcdef`)
    assert.equal(notABundle.status, 404)
  })
})

test('GET /s/<id>/<fid>: jede Teildatei bekommt IHRE eigene Vorschau (Cache-Trennung)', async () => {
  await withServer(async (handle, store) => {
    const { id, fids } = await makeBundle(store, [
      { name: 'a.txt', mime: 'text/plain', data: Buffer.from('INHALT-DER-ERSTEN-DATEI') },
      { name: 'b.txt', mime: 'text/plain', data: Buffer.from('INHALT-DER-ZWEITEN-DATEI') }
    ])

    const first = await request(handle.port, `/s/${id}/${fids[0]}`)
    const second = await request(handle.port, `/s/${id}/${fids[1]}`)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const a = first.body.toString('utf-8')
    const b = second.body.toString('utf-8')

    assert.match(a, /INHALT-DER-ERSTEN-DATEI/)
    assert.doesNotMatch(a, /INHALT-DER-ZWEITEN-DATEI/)
    assert.match(b, /INHALT-DER-ZWEITEN-DATEI/)
    assert.doesNotMatch(b, /INHALT-DER-ERSTEN-DATEI/)
  })
})

test('GET /f/<id>/<fid>: bit-identisch, Range/206, unbekannte fid -> 404, .html -> attachment', async () => {
  await withServer(async (handle, store) => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 250, 251, 252, 253, 254, 255])
    const { id, fids } = await makeBundle(store, [
      { name: 'roh.bin', mime: 'application/octet-stream', data: bytes },
      { name: 'seite.html', mime: 'text/html', data: Buffer.from('<html>hi</html>') }
    ])

    const full = await request(handle.port, `/f/${id}/${fids[0]}`)
    assert.equal(full.status, 200)
    assert.equal(full.headers['content-length'], String(bytes.length))
    assert.deepEqual(full.body, bytes)
    assert.match(String(full.headers['content-disposition']), /roh\.bin/)
    assert.equal(full.headers['content-security-policy'], 'sandbox allow-downloads')

    const partial = await request(handle.port, `/f/${id}/${fids[0]}`, {
      headers: { Range: 'bytes=0-3' }
    })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers['content-range'], `bytes 0-3/${bytes.length}`)
    assert.deepEqual(partial.body, bytes.subarray(0, 4))

    const html = await request(handle.port, `/f/${id}/${fids[1]}`)
    assert.equal(html.status, 200)
    assert.match(String(html.headers['content-disposition']), /^attachment;/)

    const unknown = await request(handle.port, `/f/${id}/ZZZZZZ`)
    assert.equal(unknown.status, 404)
  })
})

test('GET /f/<id> einer Sammlung: ZIP mit exakter Content-Length, HEAD, kein 206', async () => {
  await withServer(async (handle, store) => {
    const eins = Buffer.from('erste datei, inhalt eins')
    const zwei = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 255, 128])
    const { id } = await makeBundle(store, [
      { name: 'eins.txt', mime: 'text/plain', data: eins },
      { name: 'zwei.bin', mime: 'application/octet-stream', data: zwei }
    ])

    const res = await request(handle.port, `/f/${id}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/zip')
    assert.equal(res.headers['content-length'], String(res.body.length))
    assert.equal(res.headers['accept-ranges'], 'none')
    assert.match(String(res.headers['content-disposition']), /^attachment;/)
    assert.match(String(res.headers['content-disposition']), new RegExp(`foldwing-${id}\\.zip`))
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['content-security-policy'], 'sandbox allow-downloads')

    const entries = parseZip(res.body)
    assert.deepEqual(
      entries.map((e) => e.name),
      ['eins.txt', 'zwei.bin']
    )
    assert.deepEqual(
      entries.map((e) => e.size),
      [eins.length, zwei.length]
    )
    // Verlustfrei: die Rohbytes im Archiv sind identisch mit dem Original.
    assert.deepEqual(Buffer.from(entries[0].data), eins)
    assert.deepEqual(Buffer.from(entries[1].data), zwei)

    // HEAD: dieselben Header, kein Rumpf.
    const head = await request(handle.port, `/f/${id}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers['content-type'], 'application/zip')
    assert.equal(head.headers['content-length'], res.headers['content-length'])

    // Range darf hier NICHT zu einer (falschen) Teilantwort führen.
    const ranged = await request(handle.port, `/f/${id}`, { headers: { Range: 'bytes=0-3' } })
    assert.equal(ranged.status, 200)
    assert.equal(ranged.headers['content-range'], undefined)
    assert.deepEqual(ranged.body, res.body)
  })
})

test('ZIP: doppelte Dateinamen werden eindeutig gemacht (bild.png / bild (2).png)', async () => {
  await withServer(async (handle, store) => {
    const { id } = await makeBundle(store, [
      { name: 'bild.png', mime: 'image/png', data: Buffer.from('erstes bild') },
      { name: 'bild.png', mime: 'image/png', data: Buffer.from('zweites bild') }
    ])

    const res = await request(handle.port, `/f/${id}`)
    assert.equal(res.status, 200)
    const entries = parseZip(res.body)
    assert.deepEqual(
      entries.map((e) => e.name),
      ['bild.png', 'bild (2).png']
    )
    assert.equal(Buffer.from(entries[1].data).toString('utf-8'), 'zweites bild')
  })
})

test('abgelaufene Sammlung: /s, /s/<fid>, /f und /f/<fid> sind alle 404', async () => {
  await withServer(async (handle, store) => {
    const { id, fids } = await makeBundle(
      store,
      [{ name: 'alt.txt', mime: 'text/plain', data: Buffer.from('vergangenheit') }],
      Date.now() - 60_000
    )

    for (const p of [`/s/${id}`, `/s/${id}/${fids[0]}`, `/f/${id}`, `/f/${id}/${fids[0]}`]) {
      const res = await request(handle.port, p)
      assert.equal(res.status, 404, `${p} sollte 404 sein`)
    }
  })
})

test('Sammlung: Traversal-Versuche in der fid laufen ins Leere (404, kein Absturz)', async () => {
  await withServer(async (handle, store) => {
    const { id } = await makeBundle(store, [
      { name: 'geheim.txt', mime: 'text/plain', data: Buffer.from('nix') }
    ])

    for (const p of [
      `/f/${id}/..`,
      `/f/${id}/%2e%2e`,
      `/f/${id}/%2e%2e%2f%2e%2e%2fteam.json`,
      `/f/${id}/abc`,
      `/s/${id}/..`,
      `/s/${id}/%2e%2e`
    ]) {
      const res = await request(handle.port, p)
      assert.equal(res.status, 404, `${p} sollte 404 sein`)
    }

    // Der Server lebt danach noch.
    const alive = await request(handle.port, '/api/health')
    assert.equal(alive.status, 200)
  })
})

test('ZIP: fehlt eine Teildatei auf der Platte -> 404 (statt falscher Content-Length)', async () => {
  await withServer(async (handle, store) => {
    const { id, fids } = await makeBundle(store, [
      { name: 'da.txt', mime: 'text/plain', data: Buffer.from('vorhanden') },
      { name: 'weg.txt', mime: 'text/plain', data: Buffer.from('gleich weg') }
    ])
    rmSync(store.binPath(id, fids[1]), { force: true })

    const res = await request(handle.port, `/f/${id}`)
    assert.equal(res.status, 404)
  })
})

test('forgetPreview räumt auch die Teildatei-Einträge einer Sammlung weg', async () => {
  await withServer(async (handle, store) => {
    const { id, fids } = await makeBundle(store, [
      { name: 'notiz.txt', mime: 'text/plain', data: Buffer.from('ALT') }
    ])

    const first = await request(handle.port, `/s/${id}/${fids[0]}`)
    assert.equal(first.status, 200)
    assert.match(first.body.toString('utf-8'), /ALT/)

    // Ablaufen lassen und abrufen: dabei muss der Zwischenspeicher der Freigabe
    // samt "<id>/<fid>"-Einträgen fallen.
    await store.setExpiry(id, Date.now() - 1000)
    assert.equal((await request(handle.port, `/s/${id}`)).status, 404)

    // Wieder freischalten, Inhalt austauschen -> es darf nichts Altes mehr kommen.
    await store.setExpiry(id, null)
    writeFileSync(store.binPath(id, fids[0]), 'NEU')

    const second = await request(handle.port, `/s/${id}/${fids[0]}`)
    assert.equal(second.status, 200)
    assert.match(second.body.toString('utf-8'), /NEU/)
    assert.doesNotMatch(second.body.toString('utf-8'), /ALT/)
  })
})

/* ------------------------------------------------------------------ */
/* Relay-Pfadfamilie: /<T>, /<T>/<F>, /<T>/d, /<T>/<F>/d, /<T>/_font   */
/* ------------------------------------------------------------------ */

test('Relay: /<T> liefert die Seite mit Relay-Links, /<T>/d die bit-identische Datei', async () => {
  await withServer(async (handle, store) => {
    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255])
    const id = store.begin('roh.bin', 'application/octet-stream')
    await store.write(id, bytes)
    await store.finalize(id)
    const T = DEVICE + id

    const page = await request(handle.port, `/${T}`)
    assert.equal(page.status, 200)
    const html = page.body.toString('utf-8')
    assert.ok(html.includes(`href="/${T}/d?dl=1"`), 'Download-Link in Relay-Familie')
    assert.ok(html.includes(`url('/${T}/_font/Geist-Variable.woff2')`), 'Schriften in Relay-Familie')
    assert.ok(!html.includes('"/f/') && !html.includes('"/s/'), 'keine LAN-Pfade')
    assert.ok(html.includes(`href="/_/melden?l=${T}"`))
    const csp = String(page.headers['content-security-policy'])
    assert.match(csp, /script-src 'none'/)
    // Rohdaten leitet der Relay per 302 auf den Tunnel um – die Seite darf sie von dort laden.
    assert.match(csp, /img-src [^;]*https:\/\/\*\.trycloudflare\.com/)
    assert.match(csp, /frame-src [^;]*https:\/\/\*\.trycloudflare\.com/)

    const raw = await request(handle.port, `/${T}/d?dl=1`)
    assert.equal(raw.status, 200)
    assert.deepEqual(raw.body, bytes)
    assert.match(String(raw.headers['content-disposition']), /^attachment;/)

    const ranged = await request(handle.port, `/${T}/d`, { headers: { Range: 'bytes=2-5' } })
    assert.equal(ranged.status, 206)
    assert.deepEqual(ranged.body, bytes.subarray(2, 6))
  })
})

test('Relay: Rohdaten dürfen von fremder Herkunft eingebettet werden (PDF ohne Sandbox, kein frame-ancestors)', async () => {
  await withServer(async (handle, store) => {
    const pdf = store.begin('handbuch.pdf', 'application/pdf')
    await store.write(pdf, Buffer.from('%PDF-1.4 nicht echt'))
    await store.finalize(pdf)
    const img = store.begin('bild.png', 'image/png')
    await store.write(img, Buffer.from('fake-png'))
    await store.finalize(img)

    const p = await request(handle.port, `/${DEVICE}${pdf}/d`)
    assert.equal(p.status, 200)
    assert.equal(p.headers['content-security-policy'], undefined)
    assert.equal(p.headers['x-frame-options'], undefined)
    assert.match(String(p.headers['content-disposition']), /^inline;/)

    const i = await request(handle.port, `/${DEVICE}${img}/d`)
    assert.equal(i.status, 200)
    assert.equal(i.headers['content-security-policy'], 'sandbox allow-downloads')
    assert.equal(i.headers['x-frame-options'], undefined)
    assert.doesNotMatch(String(i.headers['content-security-policy']), /frame-ancestors/)
  })
})

test('Relay: Sammlung unter /<T>, /<T>/<F> und /<T>/<F>/d', async () => {
  await withServer(async (handle, store) => {
    const { id, fids } = await makeBundle(store, [
      { name: 'eins.txt', mime: 'text/plain', data: Buffer.from('INHALT-EINS') },
      { name: 'zwei.txt', mime: 'text/plain', data: Buffer.from('INHALT-ZWEI') }
    ])
    const T = DEVICE + id
    const overview = (await request(handle.port, `/${T}`)).body.toString('utf-8')
    for (const f of fids) {
      assert.ok(overview.includes(`href="/${T}/${f}"`))
      assert.ok(overview.includes(`href="/${T}/${f}/d?dl=1"`))
    }
    const part = await request(handle.port, `/${T}/${fids[1]}`)
    assert.equal(part.status, 200)
    assert.match(part.body.toString('utf-8'), /INHALT-ZWEI/)
    assert.ok(part.body.toString('utf-8').includes(`<a class="backlink" href="/${T}">`))

    const raw = await request(handle.port, `/${T}/${fids[0]}/d`)
    assert.equal(raw.body.toString('utf-8'), 'INHALT-EINS')

    const zip = await request(handle.port, `/${T}/d`)
    assert.equal(zip.headers['content-type'], 'application/zip')
    assert.deepEqual(
      parseZip(zip.body).map((e) => e.name),
      ['eins.txt', 'zwei.txt']
    )
  })
})

test('Relay: Vorschau-Cache trennt die Pfadfamilien (Seite über LAN und Relay)', async () => {
  await withServer(async (handle, store) => {
    const id = store.begin('foto.png', 'image/png')
    await store.write(id, Buffer.from('fake'))
    await store.finalize(id)
    const T = DEVICE + id
    // Erst LAN abrufen (füllt den Cache), dann Relay: die Relay-Seite darf nicht
    // die zwischengespeicherte LAN-Vorschau mit /f/<id> bekommen – und umgekehrt.
    const lan = (await request(handle.port, `/s/${id}`)).body.toString('utf-8')
    const relay = (await request(handle.port, `/${T}`)).body.toString('utf-8')
    const lan2 = (await request(handle.port, `/s/${id}`)).body.toString('utf-8')
    assert.ok(lan.includes(`<img src="/f/${id}"`))
    assert.ok(relay.includes(`<img src="/${T}/d"`))
    assert.ok(!relay.includes(`/f/${id}`))
    assert.equal(lan2, lan)
  })
})

test('Relay: fremde Geräte-ID, fehlende Geräte-ID und falsche Formen -> 404', async () => {
  await withServer(async (handle, store) => {
    const id = store.begin('x.txt', 'text/plain')
    await store.write(id, Buffer.from('x'))
    await store.finalize(id)
    for (const p of [
      `/Fremd123${id}`,
      `/Fremd123${id}/d`,
      `/Fremd123${id}/_font/Geist-Variable.woff2`,
      `/${DEVICE}${id}/x`,
      `/${DEVICE}${id}/abcdefg`,
      `/${DEVICE}${id}/abcdef/x`,
      `/${DEVICE}${id}/_font/evil.woff2`,
      `/${DEVICE}${id}/..%2f..%2fx`,
      `/${DEVICE}${id.slice(0, 9)}`
    ]) {
      assert.equal((await request(handle.port, p)).status, 404, p)
    }
  })
  await withServer(
    async (handle, store) => {
      const id = store.begin('x.txt', 'text/plain')
      await store.write(id, Buffer.from('x'))
      await store.finalize(id)
      assert.equal((await request(handle.port, `/${DEVICE}${id}`)).status, 404)
      // Die LAN-Familie geht trotzdem.
      assert.equal((await request(handle.port, `/s/${id}`)).status, 200)
    },
    { deviceId: () => null }
  )
})

test('Relay: unbekannte Freigabe -> 404-Seite mit Relay-Schriften', async () => {
  await withServer(async (handle) => {
    const T = `${DEVICE}AAAAAAAAAA`
    const res = await request(handle.port, `/${T}`)
    assert.equal(res.status, 404)
    assert.ok(res.body.toString('utf-8').includes(`url('/${T}/_font/Geist-Variable.woff2')`))
  })
})

test('startServer mit host 127.0.0.1 lauscht nur lokal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foldwing-server-host-'))
  const store = new ShareStore(dir)
  await store.init()
  const handle = await startServer(store, 0, makeHooks(), '127.0.0.1')
  try {
    const addr = handle.server.address()
    assert.ok(addr && typeof addr === 'object')
    assert.equal(addr.address, '127.0.0.1')
    assert.equal((await request(handle.port, '/api/health')).status, 200)
  } finally {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
