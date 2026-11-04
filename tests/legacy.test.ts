import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import {
  resolveDataDir,
  migrateConfigFile,
  defaultPicturesDir,
  legacyLinuxFiles,
  LEGACY_WINDOWS_KEYS,
  LEGACY_WINDOWS_VALUES
} from '../src/main/legacy'

/** Kleines Dateisystem im Speicher: nur Existenz und Umbenennen. */
function fakeFs(paths: string[], failRename = false) {
  const set = new Set(paths)
  const renames: [string, string][] = []
  return {
    set,
    renames,
    exists: (p: string) => set.has(p),
    rename: (a: string, b: string) => {
      if (failRename) throw new Error('EBUSY')
      set.delete(a)
      set.add(b)
      renames.push([a, b])
    }
  }
}

const APPDATA = join('C:', 'Users', 'alex', 'AppData', 'Roaming')
const NEU = join(APPDATA, 'Foldwing')
const ALT = join(APPDATA, 'FlowShare')

test('neuer Datenordner vorhanden: nichts umbenennen', () => {
  const fs = fakeFs([NEU, ALT])
  assert.equal(resolveDataDir(APPDATA, NEU, fs), NEU)
  assert.deepEqual(fs.renames, [])
})

test('nur alter Datenordner: wird zum neuen umbenannt', () => {
  const fs = fakeFs([ALT])
  assert.equal(resolveDataDir(APPDATA, NEU, fs), NEU)
  assert.deepEqual(fs.renames, [[ALT, NEU]])
})

test('Linux schreibt den alten Ordner klein: wird auch gefunden', () => {
  const alt = join(APPDATA, 'flowshare')
  const fs = fakeFs([alt])
  assert.equal(resolveDataDir(APPDATA, NEU, fs), NEU)
  assert.deepEqual(fs.renames, [[alt, NEU]])
})

test('Umbenennen scheitert (Datei gesperrt): App bleibt beim alten Ordner', () => {
  const fs = fakeFs([ALT], true)
  assert.equal(resolveDataDir(APPDATA, NEU, fs), ALT)
})

test('frische Installation: neuer Ordner', () => {
  const fs = fakeFs([])
  assert.equal(resolveDataDir(APPDATA, NEU, fs), NEU)
})

test('alte Config-Datei wird umbenannt, eine vorhandene neue bleibt unangetastet', () => {
  const alt = join(NEU, 'flowshare-config.json')
  const neu = join(NEU, 'foldwing-config.json')
  const fs1 = fakeFs([alt])
  migrateConfigFile(NEU, 'foldwing-config.json', fs1)
  assert.deepEqual(fs1.renames, [[alt, neu]])
  const fs2 = fakeFs([alt, neu])
  migrateConfigFile(NEU, 'foldwing-config.json', fs2)
  assert.deepEqual(fs2.renames, [])
})

test('Screenshots: alter Bilderordner bleibt, bis es einen neuen gibt', () => {
  const pics = join('C:', 'Users', 'alex', 'Pictures')
  const alt = join(pics, 'FlowShare')
  const neu = join(pics, 'Foldwing')
  assert.equal(defaultPicturesDir(pics, 'Foldwing', (p) => p === alt), alt)
  assert.equal(defaultPicturesDir(pics, 'Foldwing', (p) => p === alt || p === neu), neu)
  assert.equal(defaultPicturesDir(pics, 'Foldwing', () => false), neu)
})

test('Aufräumlisten zielen nur auf den alten Namen und den aktuellen Benutzer', () => {
  for (const k of LEGACY_WINDOWS_KEYS) {
    assert.ok(k.startsWith('HKEY_CURRENT_USER\\'))
    assert.ok(k.endsWith('\\FlowShare'))
  }
  for (const v of LEGACY_WINDOWS_VALUES) {
    assert.ok(v.key.startsWith('HKEY_CURRENT_USER\\'))
    assert.equal(v.value, 'electron.app.FlowShare')
  }
  for (const f of legacyLinuxFiles('/tmp/xdg/data', '/tmp/xdg/config')) {
    assert.match(f, /flowshare|FlowShare/)
  }
})
