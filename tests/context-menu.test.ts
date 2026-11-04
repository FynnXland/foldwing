import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractSharePath,
  mimeFromName,
  regEscape,
  parseRegDefaultValue,
  shSingleQuote,
  buildNautilusScript,
  buildShareDesktopEntry
} from '../src/main/context-menu'

test('extractSharePath: gepackter Erststart (exe, Marker, Datei)', () => {
  const argv = ['C:\\Program Files\\Foldwing\\Foldwing.exe', '--fs-share', 'D:\\Daten\\datei.txt']
  assert.equal(extractSharePath(argv), 'D:\\Daten\\datei.txt')
})

test('extractSharePath: Dev-Start mit "." als App-Pfad', () => {
  const argv = ['electron.exe', '.', '--fs-share', 'D:\\Daten\\datei.txt']
  assert.equal(extractSharePath(argv), 'D:\\Daten\\datei.txt')
})

test('extractSharePath: umsortierte Zweitinstanz-argv (Schalter vor der Datei)', () => {
  const argv = [
    'C:\\Program Files\\Foldwing\\Foldwing.exe',
    '--fs-share',
    '--allow-file-access-from-files',
    '.',
    'D:\\Daten\\datei.txt'
  ]
  assert.equal(extractSharePath(argv), 'D:\\Daten\\datei.txt')
})

test('extractSharePath: Pfad mit Leerzeichen bleibt als ein Argument erhalten', () => {
  const argv = ['Foldwing.exe', '--fs-share', 'D:\\Daten\\Meine Datei.txt']
  assert.equal(extractSharePath(argv), 'D:\\Daten\\Meine Datei.txt')
})

test('extractSharePath: Linux-Pfad', () => {
  const argv = ['/opt/Foldwing/foldwing', '--fs-share', '/srv/daten/datei.txt']
  assert.equal(extractSharePath(argv), '/srv/daten/datei.txt')
})

test('extractSharePath: kein Marker -> null', () => {
  const argv = ['Foldwing.exe', 'D:\\Daten\\datei.txt']
  assert.equal(extractSharePath(argv), null)
})

test('extractSharePath: Marker ohne Datei -> null', () => {
  assert.equal(extractSharePath(['Foldwing.exe', '--fs-share']), null)
  assert.equal(extractSharePath(['Foldwing.exe', '.', '--fs-share']), null)
})

test('mimeFromName: bekannte Endungen', () => {
  assert.equal(mimeFromName('bild.png'), 'image/png')
  assert.equal(mimeFromName('dokument.pdf'), 'application/pdf')
  assert.equal(mimeFromName('video.mp4'), 'video/mp4')
  assert.equal(
    mimeFromName('bericht.docx'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
})

test('mimeFromName: unbekannte Endung -> octet-stream', () => {
  assert.equal(mimeFromName('datei.xyz123'), 'application/octet-stream')
})

test('mimeFromName: ohne Endung -> octet-stream', () => {
  assert.equal(mimeFromName('README'), 'application/octet-stream')
})

test('mimeFromName: mehrere Punkte -> nur die letzte Endung zählt', () => {
  assert.equal(mimeFromName('archiv.tar.gz'), 'application/octet-stream')
  assert.equal(mimeFromName('meine.datei.png'), 'image/png')
})

test('regEscape: verdoppelt Backslashes', () => {
  assert.equal(regEscape('D:\\Daten\\test'), 'D:\\\\Daten\\\\test')
})

test('regEscape: escaped Anführungszeichen', () => {
  assert.equal(regEscape('sag "hallo"'), 'sag \\"hallo\\"')
})

test('regEscape: Backslash und Anführungszeichen zusammen', () => {
  assert.equal(regEscape('C:\\Pfad mit "Space"\\app.exe'), 'C:\\\\Pfad mit \\"Space\\"\\\\app.exe')
})

// Ausgabe von `reg query <schlüssel> /ve`, so wie reg.exe sie liefert (CRLF, 4 Leerzeichen).
// String.raw: Backslashes bleiben wörtlich stehen, wie in der echten Ausgabe.
const CMD = String.raw`"C:\Program Files\Foldwing\Foldwing.exe" --fs-share "%1"`
const KEY = String.raw`HKEY_CURRENT_USER\Software\Classes\*\shell\Foldwing\command`
const REG_DE = `\r\n${KEY}\r\n    (Standard)    REG_SZ    ${CMD}\r\n\r\n`
const REG_EN = REG_DE.replace('(Standard)', '(Default)')

test('parseRegDefaultValue: liest den Standardwert, egal in welcher Systemsprache', () => {
  assert.equal(parseRegDefaultValue(REG_DE), CMD)
  assert.equal(parseRegDefaultValue(REG_EN), CMD)
})

test('parseRegDefaultValue: REG_EXPAND_SZ wird ebenso gelesen', () => {
  assert.equal(parseRegDefaultValue(REG_DE.replace('REG_SZ', 'REG_EXPAND_SZ')), CMD)
})

test('parseRegDefaultValue: leerer Wert -> leerer Text, fehlender Schlüssel -> null', () => {
  assert.equal(parseRegDefaultValue(`\r\n${KEY}\r\n    (Standard)    REG_SZ\r\n`), '')
  // reg.exe bei fehlendem Schlüssel: nur eine Fehlermeldung, kein Wert.
  assert.equal(parseRegDefaultValue('FEHLER: Der angegebene Registrierungsschlüssel bzw. Wert wurde nicht gefunden.\r\n'), null)
  assert.equal(parseRegDefaultValue(''), null)
})

// ---- Linux: .desktop-Eintrag und Nautilus-Skript ----------------------------

test('shSingleQuote: einfache Anführungszeichen werden für die Shell geschützt', () => {
  assert.equal(shSingleQuote('/opt/Foldwing/foldwing'), "'/opt/Foldwing/foldwing'")
  assert.equal(shSingleQuote("/opt/Alex's Apps/Foldwing.AppImage"), String.raw`'/opt/Alex'\''s Apps/Foldwing.AppImage'`)
  // $, Backticks und Leerzeichen bleiben in einfachen Anführungszeichen wörtlich.
  assert.equal(shSingleQuote('/tmp/$HOME `x` y'), "'/tmp/$HOME `x` y'")
})

test('buildNautilusScript: Shebang, gequoteter Pfad, absolute Pfade, Hintergrund-Aufruf', () => {
  const s = buildNautilusScript("/opt/Alex's Apps/Foldwing.AppImage")
  assert.ok(s.startsWith('#!/bin/sh\n'))
  assert.ok(s.includes(String.raw`exe='/opt/Alex'\''s Apps/Foldwing.AppImage'` + '\n'))
  assert.ok(s.includes('case "$f" in /*) p="$f" ;; *) p="$PWD/$f" ;; esac'))
  assert.ok(s.includes('[ -f "$p" ] || continue'))
  assert.ok(s.includes('"$exe" --fs-share "$p" >/dev/null 2>&1 &'))
})

test('buildNautilusScript: läuft mit /bin/sh und reicht nur Dateien als absolute Pfade weiter', { skip: process.platform === 'win32' }, async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, chmodSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'fs-nautilus-'))
  try {
    // Ersatz für die App: jeder Aufruf schreibt seine Argumente in eine eigene Datei
    // (die Aufrufe laufen parallel im Hintergrund).
    const calls = join(dir, 'aufrufe')
    mkdirSync(calls)
    const fake = join(dir, "Alex's Foldwing")
    writeFileSync(fake, `#!/bin/sh\nprintf '%s|' "$@" > '${calls}'/$$\n`)
    chmodSync(fake, 0o755)
    const work = join(dir, 'arbeit')
    mkdirSync(work)
    const script = join(dir, 'skript')
    writeFileSync(script, buildNautilusScript(fake))
    chmodSync(script, 0o755)
    writeFileSync(join(work, 'notiz für alex.txt'), 'Hallo')
    writeFileSync(join(work, '-strich.txt'), 'Hallo')
    mkdirSync(join(work, 'ordner'))
    // PWD absichtlich falsch (Nautilus vererbt sein eigenes) – die Shell muss den echten Ordner nehmen.
    const r = spawnSync(script, ['notiz für alex.txt', '-strich.txt', 'ordner', join(work, 'fehlt.txt')], {
      cwd: work,
      env: { ...process.env, PWD: dir }
    })
    assert.equal(r.status, 0)
    const read = (): string[] => readdirSync(calls).map((f) => readFileSync(join(calls, f), 'utf8'))
    for (let i = 0; i < 50 && read().filter((l) => l.endsWith('|')).length < 2; i++) {
      await new Promise((res) => setTimeout(res, 50))
    }
    const lines = read().sort()
    assert.deepEqual(lines, [`--fs-share|${join(work, '-strich.txt')}|`, `--fs-share|${join(work, 'notiz für alex.txt')}|`])
    // extractSharePath nimmt genau diesen Pfad – auch den mit Bindestrich am Anfang des Namens.
    assert.equal(extractSharePath(['/opt/Foldwing/foldwing', '--fs-share', join(work, '-strich.txt')]), join(work, '-strich.txt'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildShareDesktopEntry: eine Hauptkategorie, Exec gequotet, Icon nur wenn vorhanden', () => {
  const withIcon = buildShareDesktopEntry('/opt/Foldwing/foldwing', '/srv/apps/.local/share/icons/foldwing.png')
  assert.ok(withIcon.includes('Exec="/opt/Foldwing/foldwing" --fs-share %f\n'))
  assert.ok(withIcon.includes('Icon=/srv/apps/.local/share/icons/foldwing.png\n'))
  assert.ok(withIcon.includes('Categories=Utility;\n'))
  assert.ok(!withIcon.includes('Network;'))
  assert.ok(withIcon.includes('MimeType=all/allfiles;\n'))
  // Keine Zuordnung zu application/octet-stream: Foldwing darf nie Standard-App werden.
  assert.ok(!withIcon.includes('octet-stream'))
  const noIcon = buildShareDesktopEntry('/opt/Foldwing/foldwing', null)
  assert.ok(!noIcon.includes('Icon='))
})
