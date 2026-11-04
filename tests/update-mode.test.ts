import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideUpdateMode, RELEASES_URL, type UpdateModeInput } from '../src/main/update-mode'

function input(over: Partial<UpdateModeInput>): UpdateModeInput {
  return { platform: 'win32', packaged: true, installed: false, env: {}, execPath: 'C:\\Foldwing\\Foldwing.exe', ...over }
}

test('decideUpdateMode: Windows-Installer aktualisiert sich selbst', () => {
  assert.equal(decideUpdateMode(input({ installed: true })), 'auto')
})

test('decideUpdateMode: Portable nur mit Hinweis, entpackter Test-Build und Dev nie', () => {
  assert.equal(decideUpdateMode(input({ env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' } })), 'manual')
  assert.equal(decideUpdateMode(input({ installed: false })), 'none')
  assert.equal(decideUpdateMode(input({ packaged: false, installed: true })), 'none')
})

test('decideUpdateMode: Linux – AppImage selbst, .deb mit Hinweis, linux-unpacked nie', () => {
  const linux = { platform: 'linux' }
  assert.equal(decideUpdateMode(input({ ...linux, env: { APPIMAGE: '/apps/Foldwing.AppImage' } })), 'auto')
  assert.equal(decideUpdateMode(input({ ...linux, execPath: '/opt/Foldwing/foldwing' })), 'manual')
  assert.equal(decideUpdateMode(input({ ...linux, execPath: '/tmp/build/linux-unpacked/foldwing' })), 'none')
  assert.equal(decideUpdateMode(input({ platform: 'darwin' })), 'none')
})

test('RELEASES_URL zeigt auf die GitHub-Releases', () => {
  assert.equal(RELEASES_URL, 'https://github.com/FynnXland/foldwing/releases')
})
