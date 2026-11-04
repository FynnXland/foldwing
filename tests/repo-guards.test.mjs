// Wächter für das öffentliche Repository. Was einmal gepusht ist, bleibt für immer
// in der Historie, in Forks und in Caches – deshalb prüft jeder Testlauf:
//   (a) keine Zugangsdaten im Text, (b) keine Schlüsseldateien,
//   (c) keine Heimatpfade und keine privaten Begriffe des Besitzers (lokale Liste),
//   (d) lokale Dateien mit Geheimnissen oder Konto-Kennungen bleiben unverfolgt,
//   (e) Lizenz und Fremdlizenzen stimmen und kommen ins Paket,
//   (f) das CHANGELOG kennt die aktuelle Version.
// Geprüft wird alles, was `git add -A` mitnehmen würde: verfolgte Dateien plus
// neue, nicht ignorierte. Läuft offline und fasst nichts außerhalb des Repos an.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Die Tests laufen gebündelt aus .test-out/ – der Repo-Root kommt deshalb von git.
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  encoding: 'utf8'
}).trim()

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const tracked = git('ls-files', '-z').split('\0').filter(Boolean)
const candidates = [
  ...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))
].filter((rel) => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isFile())

/** Inhalt jeder Datei als Text; Binärdateien werden mitgeprüft (Metadaten in Bildern o. Ä.). */
const files = candidates.map((rel) => ({ rel, text: readFileSync(join(ROOT, rel)).toString('utf8') }))

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

// ---- (a) Zugangsdaten -------------------------------------------------------

// Aus Teilen zusammengesetzt, damit die Datei sich nicht selbst meldet.
const SECRET = new RegExp(
  '\\b(?:' +
    [
      'gh' + '[opsur]_[A-Za-z0-9]{30,}',
      'github' + '_pat_[A-Za-z0-9_]{30,}',
      'sk' + '-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}',
      'AI' + 'za[0-9A-Za-z_-]{35}',
      'AK' + 'IA[0-9A-Z]{16}',
      'xo' + 'x[abprs]-[A-Za-z0-9-]{10,}',
      'sk' + '_live_[A-Za-z0-9]{20,}',
      'hf' + '_[A-Za-z0-9]{30,}',
      'npm' + '_[A-Za-z0-9]{36}',
      'pypi' + '-[A-Za-z0-9_-]{50,}',
      // Cloudflare-API-Token und Global API Key im aktuellen Format: Präfix, 40 Zeichen, Prüfsumme
      'cf' + '(?:k|ut|at)_[A-Za-z0-9_-]{40,}',
      // cloudflared-Tunnel-Token: Base64 von {"a":"<Konto>","t":"<Tunnel>","s":"<Geheimnis>"}
      'eyJh' + 'Ijoi[A-Za-z0-9+/_=-]{60,}'
    ].join('|') +
    ')' +
    // Cloudflare-API-Token im alten Format (40 Zeichen ohne Präfix) hinter dem Variablennamen
    '|\\b(?:CF|CLOUDFLARE)_API_' +
    'TOKEN["\']?\\s*[:=]\\s*["\']?[A-Za-z0-9_-]{40}\\b' +
    '|-----BEGIN [A-Z ]*PRI' +
    'VATE KEY',
  'g'
)

test('(a) keine Zugangsdaten in Dateien des Repositorys', () => {
  const funde = []
  for (const { rel, text } of files) {
    for (const m of text.matchAll(SECRET)) {
      funde.push(`${rel}:${lineOf(text, m.index)}: sieht aus wie ${m[0].slice(0, 4)}…`)
    }
  }
  assert.deepEqual(funde, [], `Mögliche Zugangsdaten gefunden:\n${funde.join('\n')}`)
})

// ---- (b) Schlüsseldateien ---------------------------------------------------

// .env, .env.local usw. sind verboten, .env.example/.sample/.template erlaubt.
const KEY_FILE =
  /(^|\/)\.env(\.(?!(example|sample|template)$)[^/]+)?$|(^|\/)\.dev\.vars(\.[^/]+)?$|\.(pem|key|p12|pfx|jks|keystore)$/i

test('(b) keine Schlüsseldateien im Repository', () => {
  const funde = candidates.filter((rel) => KEY_FILE.test(rel))
  assert.deepEqual(funde, [], `Schlüsseldateien: ${funde.join(', ')}`)
})

// ---- (c) Heimatpfade und private Mail-Domain --------------------------------

// Laufwerk:\Users\<Name> (auch mit doppeltem Backslash oder /) sowie /home/<Name> und
// /Users/<Name>. Platzhalter in spitzen Klammern sind erlaubt, echte Namen nicht.
const HOME_PATH = /\b[a-z]:(?:\\{1,2}|\/)users(?:\\{1,2}|\/)[a-z]|(?<![\w.~-])\/(?:home|users)\/[a-z]/gi

test('(c) keine Heimatpfade mit Benutzernamen', () => {
  const funde = []
  for (const { rel, text } of files) {
    for (const m of text.matchAll(HOME_PATH)) funde.push(`${rel}:${lineOf(text, m.index)}`)
  }
  assert.deepEqual(funde, [], `Heimatpfade gefunden:\n${funde.join('\n')}`)
})

// Private Begriffe des Besitzers (Klarname, Mail-Domain, Kontoname, Anschrift …)
// stehen bewusst NICHT im Repository – auch nicht als Hash: kurze Werte ließen sich
// per Wörterbuch zurückrechnen, und der Hash bestätigt jede Vermutung. Wer sie prüfen
// will, legt sie zeilenweise in `.git/info/private-terms` ab (`#` = Kommentar).
// Dateien unter `.git/` werden nie veröffentlicht. Fehlt die Datei (fremder Klon, CI),
// wird der Test übersprungen.
const PRIVATE_TERMS_FILE = join(ROOT, '.git', 'info', 'private-terms')

function readPrivateTerms() {
  try {
    return readFileSync(PRIVATE_TERMS_FILE, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4 && !s.startsWith('#'))
  } catch {
    return null
  }
}

/**
 * Fundstellen der Begriffe, ohne Groß-/Kleinschreibung. Bei Domains zählt auch die
 * umgedrehte Schreibweise wie in App-IDs (`de.example` für `example.de`).
 */
function findTerms(text, terms) {
  const lower = text.toLowerCase()
  const hits = []
  terms.forEach((term, nr) => {
    const t = term.toLowerCase()
    const variants = t.includes('.') ? [t, t.split('.').reverse().join('.')] : [t]
    for (const v of variants) {
      let i = -1
      while ((i = lower.indexOf(v, i + 1)) !== -1) hits.push({ line: lineOf(text, i), nr: nr + 1 })
    }
  })
  return hits
}

test('(c) private Begriffe des Besitzers stehen nirgends (lokal: .git/info/private-terms)', (t) => {
  const terms = readPrivateTerms()
  if (!terms) {
    t.skip('keine .git/info/private-terms vorhanden – die Prüfung läuft nur beim Besitzer')
    return
  }
  const funde = []
  for (const { rel, text } of files) {
    for (const h of findTerms(text, terms)) funde.push(`${rel}:${h.line} (Begriff Nr. ${h.nr})`)
  }
  // Die Begriffe selbst werden bewusst nicht ausgegeben – nur Datei, Zeile, Nummer.
  assert.deepEqual(funde, [], `Private Begriffe gefunden:\n${funde.join('\n')}`)
})

test('(c) die Begriffssuche findet Adresse, Subdomain und App-ID-Schreibweise', () => {
  const lines = (text, terms) => findTerms(text, terms).map((h) => h.line)
  assert.deepEqual(lines('Mail an jemand@Example.org', ['example.org']), [1])
  assert.deepEqual(lines('\nhttps://share.example.org/s/abc', ['example.org']), [2])
  assert.deepEqual(lines('"appId": "org.example.app"', ['example.org']), [1])
  assert.deepEqual(lines('Erika Mustermann', ['erika mustermann']), [1])
  assert.deepEqual(lines('example.com, example.net.test', ['example.org']), [])
})

// ---- (d) lokale Dateien bleiben unverfolgt ------------------------------------

const LOCAL_ONLY = [
  'resources/team.json',
  'worker/wrangler.toml',
  'worker/relay/wrangler.toml',
  'resources/cloudflared.exe',
  'resources/cloudflared-linux-amd64'
]

test('(d) alte Team-Konfiguration, Worker-Deploy-Dateien und cloudflared sind nicht verfolgt', () => {
  const verfolgt = tracked.filter((rel) => LOCAL_ONLY.includes(rel) || rel.startsWith('resources/cloudflared'))
  assert.deepEqual(verfolgt, [], `Verfolgt, obwohl lokal: ${verfolgt.join(', ')}`)
})

test('(d) .gitignore hält diese Dateien draußen', () => {
  for (const rel of LOCAL_ONLY) {
    const r = spawnSync('git', ['check-ignore', '--no-index', '-q', rel], { cwd: ROOT })
    assert.equal(r.status, 0, `${rel} ist nicht ignoriert`)
  }
})

// ---- (e) Lizenz und Fremdlizenzen ---------------------------------------------

const pkg = JSON.parse(read('package.json'))

test('(e) LICENSE ist MIT mit FynnXland als Rechteinhaber, package.json sagt MIT', () => {
  const license = read('LICENSE').replace(/\r\n/g, '\n')
  assert.match(license, /^MIT License\n/)
  assert.match(license, /^Copyright \(c\) \d{4} FynnXland$/m)
  assert.equal(pkg.license, 'MIT')
})

test('(e) LICENSE und THIRD-PARTY-NOTICES.md kommen ins Paket', () => {
  const sources = (pkg.build?.extraResources ?? []).map((e) => (typeof e === 'string' ? e : e.from))
  for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    assert.ok(sources.includes(file), `${file} fehlt in build.extraResources`)
    assert.ok(existsSync(join(ROOT, file)), `${file} fehlt im Repository`)
  }
})

test('(e) THIRD-PARTY-NOTICES.md nennt alle Laufzeit-Abhängigkeiten und Mitgeliefertes', () => {
  const notices = read('THIRD-PARTY-NOTICES.md')
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const names = [...Object.keys(pkg.dependencies ?? {}), 'electron', 'react', 'react-dom', 'Geist', 'cloudflared']
  const fehlt = names.filter((name) => !new RegExp(`^\\| ${escape(name)}(?: \\(| \\|)`, 'im').test(notices))
  assert.deepEqual(fehlt, [], `Fehlt in THIRD-PARTY-NOTICES.md: ${fehlt.join(', ')}`)
})

test('(e) THIRD-PARTY-NOTICES.md ist aktuell und enthält nur freizügige Lizenzen', () => {
  const r = spawnSync(process.execPath, ['scripts/third-party-notices.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
})

// ---- (f) CHANGELOG -------------------------------------------------------------

test('(f) CHANGELOG.md hat einen Abschnitt für die Version aus package.json', () => {
  const changelog = read('CHANGELOG.md')
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/gm)].map((m) => m[1])
  assert.ok(versions.includes(pkg.version), `Kein Abschnitt „## [${pkg.version}] - JJJJ-MM-TT“ in CHANGELOG.md`)
  const key = (v) => v.split('.').map(Number)
  const sorted = [...versions].sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
  })
  assert.deepEqual(versions, sorted, 'Versionen stehen nicht absteigend (neueste zuerst)')
})
