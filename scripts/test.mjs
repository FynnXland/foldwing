// Leichtgewichtiger Test-Runner: bündelt jede tests/**/*.test.ts (und .test.mjs)
// einzeln mit esbuild (electron-frei -> external) nach .test-out/ und führt die
// Bundles dann mit `node --test` aus. esbuild steht als eigene devDependency in
// package.json (seit vite 8 bringt die Build-Kette es nicht mehr mit).
import { build } from 'esbuild'
import { readdirSync, statSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join, relative, dirname, sep } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(scriptsDir, '..')
const testsDir = join(projectRoot, 'tests')
// Eigener Ausgabeordner per FOLDWING_TEST_OUT=<name>, damit parallele Läufe sich nicht
// gegenseitig die Bundles löschen. Der Ordner liegt immer im Projekt (.test-out-<name>),
// weil die Bundles node_modules und git relativ zu ihrem Ort finden müssen. Argumente filtern die Testdateien nach Namen,
// z. B. `node scripts/test.mjs relay` läuft nur Dateien mit „relay“ im Pfad.
const outName = (process.env.FOLDWING_TEST_OUT ?? '').replace(/[^A-Za-z0-9_-]/g, '')
const outDir = join(projectRoot, outName ? `.test-out-${outName}` : '.test-out')
const filters = process.argv.slice(2)

/** tests/ rekursiv nach *.test.ts / *.test.mjs durchsuchen (fixtures/ ausgenommen). */
function findTestFiles(dir) {
  let out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'fixtures') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out = out.concat(findTestFiles(full))
    } else if (/\.test\.(ts|mjs)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

async function main() {
  if (!existsSync(testsDir)) {
    console.error('Kein tests/-Ordner gefunden – nichts zu tun.')
    process.exit(1)
  }
  const files = findTestFiles(testsDir)
    .filter((f) => filters.length === 0 || filters.some((x) => relative(testsDir, f).includes(x)))
    .sort()
  if (files.length === 0) {
    console.error('Keine Testdateien (tests/**/*.test.ts|.test.mjs) gefunden.')
    process.exit(1)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const bundles = []
  for (const file of files) {
    const rel = relative(testsDir, file).split(sep).join('/')
    const outRel = rel.replace(/\.(ts|mjs)$/, '.mjs')
    const outFile = join(outDir, ...outRel.split('/'))
    mkdirSync(dirname(outFile), { recursive: true })
    try {
      await build({
        entryPoints: [file],
        outfile: outFile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node18',
        sourcemap: false,
        logLevel: 'silent',
        // electron gibt es außerhalb der App nicht; mammoth/xlsx sind CommonJS-
        // Pakete, die esbuild beim Bündeln als ESM sonst zerlegt (unnötig langsam
        // und fehleranfällig) – node löst sie zur Laufzeit ganz normal auf.
        external: ['electron', 'mammoth', 'xlsx']
      })
      bundles.push(outFile)
    } catch (err) {
      console.error(`Bündeln fehlgeschlagen: ${rel}`)
      console.error(err.message ?? err)
      process.exit(1)
    }
  }

  const result = spawnSync(process.execPath, ['--test', ...bundles], {
    stdio: 'inherit',
    cwd: projectRoot
  })

  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }
  // node --test wirft beim Beenden manchmal einen libuv-Assertion-Fehler NACH der
  // Ausgabe (bekannte Eigenart headless laufender Node-Prozesse) – die Testergebnisse
  // selbst zählen, nicht der Exit-Krach. Exit-Code trotzdem durchreichen.
  process.exit(result.status ?? 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
