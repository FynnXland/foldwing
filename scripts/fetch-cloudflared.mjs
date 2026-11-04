// Holt das offizielle cloudflared von Cloudflares GitHub-Releases nach resources/,
// damit es in den Installer gebündelt wird:
//   Windows: cloudflared-windows-amd64.exe -> resources/cloudflared.exe
//   Linux:   cloudflared-linux-amd64       -> resources/cloudflared-linux-amd64
//
// Version und SHA256 sind fest eingetragen: Jeder Build bündelt genau dieses
// Binary. Weicht die Prüfsumme ab, bricht das Skript ab. Liegt die Datei schon mit
// der richtigen Prüfsumme da, wird nichts geladen. Eine Datei mit anderer
// Prüfsumme (z. B. eine ältere Version) wird ersetzt.
//
// Aufruf: node scripts/fetch-cloudflared.mjs [win|linux]
//         ohne Angabe: passend zum laufenden System
//
// Version heben: Release unter https://github.com/cloudflare/cloudflared/releases
// auswählen, VERSION und beide SHA256 unten eintragen (stehen in den
// Release-Notizen unter „SHA256 Checksums“ und als `digest` in der GitHub-API),
// danach `node scripts/third-party-notices.mjs` ausführen.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, rename, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '2026.8.3'

const TARGETS = {
  win: {
    asset: 'cloudflared-windows-amd64.exe',
    file: 'cloudflared.exe',
    sha256: '83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae'
  },
  linux: {
    asset: 'cloudflared-linux-amd64',
    file: 'cloudflared-linux-amd64',
    sha256: 'f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e'
  }
}

const log = (msg) => console.log(`[Foldwing] ${msg}`)

class FetchError extends Error {}

function pickPlatform(arg) {
  if (arg) return arg
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'linux') return 'linux'
  return null
}

/** SHA256 einer vorhandenen Datei, `null`, wenn es sie nicht gibt. */
async function sha256OfFile(path) {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  return hash.digest('hex')
}

/** Lädt in eine Temp-Datei neben dem Ziel und benennt erst nach geprüfter Prüfsumme um. */
async function download(target, dest) {
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${target.asset}`
  log(`Lade cloudflared ${VERSION} von ${url} …`)
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok || !res.body) throw new FetchError(`Download fehlgeschlagen: HTTP ${res.status}`)

  const tmp = `${dest}.download`
  const hash = createHash('sha256')
  const out = createWriteStream(tmp)
  let bytes = 0
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      bytes += chunk.length
      if (!out.write(chunk)) await once(out, 'drain')
    }
    out.end()
    // Erst nach 'close' ist die Datei unter Windows wirklich freigegeben.
    await once(out, 'close')
  } catch (err) {
    out.destroy()
    await rm(tmp, { force: true })
    throw err
  }

  const actual = hash.digest('hex')
  if (actual !== target.sha256) {
    await rm(tmp, { force: true })
    throw new FetchError(
      `SHA256 stimmt nicht – abgebrochen, nichts ersetzt.\n  erwartet: ${target.sha256}\n  erhalten: ${actual}`
    )
  }
  await rename(tmp, dest)
  log(`cloudflared ${VERSION} gespeichert (${(bytes / 1e6).toFixed(1)} MB, SHA256 geprüft).`)
}

async function main() {
  const platform = pickPlatform(process.argv[2])
  const target = TARGETS[platform]
  if (!target) {
    throw new FetchError(
      `Unbekannte Plattform „${platform ?? process.platform}“. Aufruf: node scripts/fetch-cloudflared.mjs [win|linux]`
    )
  }

  const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', target.file)
  const existing = await sha256OfFile(dest)
  if (existing === target.sha256) {
    log(`resources/${target.file} ist schon da (cloudflared ${VERSION}, SHA256 stimmt).`)
  } else {
    if (existing) {
      log(`resources/${target.file} hat eine andere Prüfsumme (${existing}) – wird ersetzt.`)
    }
    await download(target, dest)
  }

  // Immer ausführbar machen, auch wenn die Datei schon da war: Beim Spiegeln von
  // einer mit Windows geteilten Platte (scripts/build-linux.sh) kann das x-Bit
  // verloren gehen, und dann scheitert der Start von cloudflared mit EACCES.
  if (platform === 'linux') await chmod(dest, 0o755)
}

try {
  await main()
} catch (err) {
  console.error(`[Foldwing] ${err instanceof FetchError ? err.message : err?.stack ?? err}`)
  process.exit(1)
}
