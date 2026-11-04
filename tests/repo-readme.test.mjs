// Wächter für die READMEs und die Doku: Links, Bilder, Sprungmarken und beide
// Sprachfassungen. README.md (englisch, Startseite auf GitHub) und README.de.md erzählen
// dasselbe in derselben Reihenfolge mit denselben Bildern. Läuft eine Fassung der anderen
// davon, merkt das beim Lesen der eigenen Sprache niemand – deshalb wacht dieser Test
// darüber. Dazu: Jeder lokale Link und jedes Bild in den öffentlichen Markdown-Dateien
// zeigt auf eine vorhandene Datei, jede Sprungmarke auf eine vorhandene Überschrift.
// Ein toter Link ist auf GitHub der erste Eindruck. Läuft offline und liest nur das Repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

// Die Tests laufen gebündelt aus .test-out/ – der Repo-Root kommt deshalb von git.
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  encoding: 'utf8'
}).trim()

const README_EN = 'README.md'
const README_DE = 'README.de.md'
/** Regeln für die README: eine Endnutzer-README bleibt bei höchstens ~350 Zeilen. */
const MAX_README_LINES = 360

const exists = (rel) => existsSync(join(ROOT, rel))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

function markdownIn(dir) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((f) => f.endsWith('.md') && statSync(join(abs, f)).isFile())
    .sort()
    .map((f) => `${dir}/${f}`)
}

/** Öffentliche Markdown-Dateien, deren Links geprüft werden. Fehlende fallen weg. */
const CHECKED = [
  ...new Set([
    README_EN,
    README_DE,
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'THIRD-PARTY-NOTICES.md',
    'CLAUDE.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'worker/README.md',
    'docs/media/README.md',
    ...markdownIn('docs')
  ])
].filter(exists)

// ---- Markdown zerlegen ----------------------------------------------------------

/** Code-Blöcke (auch eingerückte in Listen) und HTML-Kommentare entfernen. */
function withoutFences(text) {
  return text
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

/** Zusätzlich Inline-Code entfernen – dort stehen Beispiele, keine Links. */
function withoutCode(text) {
  return withoutFences(text).replace(/`[^`\n]*`/g, '')
}

const MD_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const MD_REF = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm
const HTML_ATTR = /\b(?:src|href)\s*=\s*"([^"]+)"/gi
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i

/** Alle Link- und Bildziele einer Datei: Markdown, Referenzen und HTML-Attribute. */
function targets(text) {
  const t = withoutCode(text)
  return [...t.matchAll(MD_LINK), ...t.matchAll(MD_REF), ...t.matchAll(HTML_ATTR)].map((m) => m[1])
}

/** %-Kodierung auflösen; Kaputtes bleibt, wie es ist (fällt dann als toter Link auf). */
function decode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Nur Ziele im Repository (ohne https:, mailto: …), jeweils als { path, anchor }. */
function localTargets(text) {
  const result = []
  for (const raw of targets(text)) {
    if (EXTERNAL.test(raw)) continue
    const [pathPart, anchor = ''] = raw.split('#', 2)
    result.push({ raw, path: decode(pathPart.split('?')[0]), anchor: decode(anchor) })
  }
  return result
}

/** Sprungmarke so, wie GitHub sie aus einer Überschrift bildet. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Links: nur der Text zählt
    .replace(/<[^>]+>/g, '') // HTML-Tags fallen weg
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '') // Satzzeichen weg, Umlaute bleiben
    .replace(/ /g, '-')
}

/** Alle Sprungmarken einer Markdown-Datei; Dubletten bekommen -1, -2 … */
function anchors(text) {
  const seen = new Map()
  const result = new Set()
  for (const m of withoutFences(text).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    const base = slug(m[1])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    result.add(n === 0 ? base : `${base}-${n}`)
  }
  return result
}

const sections = (text) => [...withoutFences(text).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())

/** Bilder aus docs/media, ohne Sprachkennung (.en./.de.). */
function media(text) {
  return new Set(
    localTargets(text)
      .map((t) => t.path.replace(/^\.\//, ''))
      .filter((p) => p.startsWith('docs/media/'))
      .map((p) => p.replace(/\.(en|de)\./, '.'))
  )
}

// ---- Tests ------------------------------------------------------------------------

test('Sprungmarken werden wie auf GitHub gebildet', () => {
  assert.equal(slug('Privacy and your data'), 'privacy-and-your-data')
  assert.equal(slug('Wenn etwas nicht geht'), 'wenn-etwas-nicht-geht')
  assert.equal(slug('Datenschutz und deine Daten'), 'datenschutz-und-deine-daten')
  assert.equal(slug('2. Write `resources/team.json`'), '2-write-resourcesteamjson')
  assert.equal(slug('Option A: a tunnel token from the dashboard'), 'option-a-a-tunnel-token-from-the-dashboard')
  assert.deepEqual([...anchors('# A\n## Setup\n```\n## Kein Titel\n```\n## Setup\n')], ['a', 'setup', 'setup-1'])
})

test('README.md und README.de.md haben gleich viele Abschnitte', () => {
  const en = sections(read(README_EN))
  const de = sections(read(README_DE))
  assert.ok(en.length >= 5, `README.md hat nur ${en.length} Abschnitte`)
  assert.equal(en.length, de.length, `README.md hat ${en.length} Abschnitte, README.de.md ${de.length}.\nEN: ${en.join(' | ')}\nDE: ${de.join(' | ')}`)
})

test('beide READMEs zeigen dieselben Bilder aus docs/media', () => {
  const en = media(read(README_EN))
  const de = media(read(README_DE))
  assert.ok(en.size > 0, 'README.md zeigt kein einziges Bild aus docs/media')
  const onlyEn = [...en].filter((m) => !de.has(m))
  const onlyDe = [...de].filter((m) => !en.has(m))
  assert.deepEqual([onlyEn, onlyDe], [[], []], `Nur in README.md: ${onlyEn.join(', ')}; nur in README.de.md: ${onlyDe.join(', ')}`)
})

test('jede README zeigt ihre eigene Sprachfassung der Bilder', () => {
  for (const [file, foreign] of [[README_EN, '.de.'], [README_DE, '.en.']]) {
    const wrong = localTargets(read(file)).filter((t) => t.path.startsWith('docs/media/') && t.path.includes(foreign))
    assert.deepEqual(wrong.map((t) => t.path), [], `${file} zeigt die andere Sprachfassung`)
  }
})

test('jedes Bild in den READMEs hat einen Alt-Text', () => {
  for (const file of [README_EN, README_DE]) {
    const without = [...withoutFences(read(file)).matchAll(/<img\b[^>]*>/gi)]
      .map((m) => m[0])
      .filter((tag) => !/\balt="[^"]*"/i.test(tag))
    assert.deepEqual(without, [], `${file}: <img> ohne alt-Attribut`)
  }
})

test('die READMEs verlinken einander (Sprachumschalter)', () => {
  const links = (file) => localTargets(read(file)).map((t) => t.path)
  assert.ok(links(README_EN).includes(README_DE), 'README.md verlinkt README.de.md nicht')
  assert.ok(links(README_DE).includes(README_EN), 'README.de.md verlinkt README.md nicht')
})

test(`die READMEs bleiben bei höchstens ${MAX_README_LINES} Zeilen`, () => {
  for (const file of [README_EN, README_DE]) {
    const lines = read(file).split('\n').length
    assert.ok(lines <= MAX_README_LINES, `${file} hat ${lines} Zeilen`)
  }
})

test('lokale Links und Bilder zeigen auf vorhandene Dateien', () => {
  const dead = []
  for (const file of CHECKED) {
    for (const t of localTargets(read(file))) {
      if (!t.path) continue // reine Sprungmarke, prüft der nächste Test
      const base = t.path.startsWith('/') ? ROOT : join(ROOT, dirname(file))
      if (!existsSync(join(base, t.path.replace(/^\/+/, '')))) dead.push(`${file}: ${t.raw}`)
    }
  }
  assert.deepEqual(dead, [], `Tote lokale Links:\n${dead.join('\n')}`)
})

test('Sprungmarken zeigen auf vorhandene Überschriften, auch in anderen Dateien', () => {
  const missing = []
  for (const file of CHECKED) {
    for (const t of localTargets(read(file))) {
      if (!t.anchor) continue
      const target = t.path ? posix.normalize(posix.join(posix.dirname(file), t.path)) : file
      if (!target.endsWith('.md') || !exists(target)) continue
      if (!anchors(read(target)).has(t.anchor.toLowerCase())) missing.push(`${file}: ${t.raw}`)
    }
  }
  assert.deepEqual(missing, [], `Sprungmarken ohne Überschrift:\n${missing.join('\n')}`)
})

test('der Troubleshooting-Link der Issue-Formulare trifft eine Überschrift der README', () => {
  const config = read('.github/ISSUE_TEMPLATE/config.yml')
  const linked = [...config.matchAll(/github\.com\/FynnXland\/foldwing#([\w-]+)/gi)].map((m) => m[1].toLowerCase())
  assert.ok(linked.length > 0, 'config.yml verlinkt keinen Abschnitt der README')
  const present = anchors(read(README_EN))
  assert.deepEqual(linked.filter((a) => !present.has(a)), [], 'Abschnitt fehlt in README.md')
})

test('README und Doku enthalten keine Steuerzeichen', () => {
  // Ein Skript, das aus „…\foldwing\…" ein „\f" macht, hinterlässt einen Seitenvorschub
  // statt eines Backslashs – im Editor unsichtbar, auf GitHub kaputt.
  const found = []
  for (const file of CHECKED) {
    const text = read(file)
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) {
        found.push(`${file}: 0x${c.toString(16).padStart(2, '0')}`)
        break
      }
    }
  }
  assert.deepEqual(found, [], `Steuerzeichen gefunden:\n${found.join('\n')}`)
})

test('kein Verweis auf entfernte Dateien', () => {
  // RELEASE.md ist in docs/releasing.md und docs/team-mode.md aufgegangen.
  const removed = ['RELEASE.md', 'Foldwing_Konzept.md']
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
    .split('\0')
    .filter((rel) => rel && exists(rel))
  const hits = []
  for (const rel of files) {
    const text = read(rel)
    for (const name of removed) if (text.includes(name)) hits.push(`${rel}: ${name}`)
  }
  assert.deepEqual(hits, [], `Verweis auf entfernte Datei:\n${hits.join('\n')}`)
})
