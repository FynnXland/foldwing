import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  isWindows,
  isLinux,
  desktopExecQuote,
  xdgConfigHome,
  xdgDataHome,
  stableExePath,
  hasStableInstallPathLinux,
  isX11Session,
  isWaylandSession,
  sessionKind
} from '../src/main/platform'

test('isWindows/isLinux: konsistent zu process.platform, nie beide gleichzeitig wahr', () => {
  assert.equal(isWindows, process.platform === 'win32')
  assert.equal(isLinux, process.platform === 'linux')
  assert.equal(isWindows && isLinux, false)
})

test('desktopExecQuote: escaped Backslash, Anführungszeichen, Backtick, Dollar und quotet', () => {
  const input = 'a"b`c$d\\e'
  const escaped = input.replace(/[\\"`$]/g, (c) => '\\' + c)
  assert.equal(desktopExecQuote(input), `"${escaped}"`)
})

test('desktopExecQuote: Pfad mit Leerzeichen und Backslashes (Windows-typisch)', () => {
  const input = 'C:\\Program Files\\Foldwing\\Foldwing.exe'
  const escaped = input.replace(/[\\"`$]/g, (c) => '\\' + c)
  assert.equal(desktopExecQuote(input), `"${escaped}"`)
  // Jeder einzelne Backslash im Original muss verdoppelt worden sein.
  const originalBackslashes = (input.match(/\\/g) ?? []).length
  const doubledBackslashes = (desktopExecQuote(input).match(/\\\\/g) ?? []).length
  assert.equal(doubledBackslashes, originalBackslashes)
})

test('desktopExecQuote: Pfad ohne Sonderzeichen wird nur in Anführungszeichen gesetzt', () => {
  assert.equal(desktopExecQuote('/opt/Foldwing/foldwing'), '"/opt/Foldwing/foldwing"')
})

test('xdgConfigHome/xdgDataHome: respektieren XDG_*-Umgebungsvariablen', () => {
  const savedConfig = process.env['XDG_CONFIG_HOME']
  const savedData = process.env['XDG_DATA_HOME']
  try {
    process.env['XDG_CONFIG_HOME'] = '/custom/config'
    process.env['XDG_DATA_HOME'] = '/custom/data'
    assert.equal(xdgConfigHome(), '/custom/config')
    assert.equal(xdgDataHome(), '/custom/data')
  } finally {
    if (savedConfig === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = savedConfig
    if (savedData === undefined) delete process.env['XDG_DATA_HOME']
    else process.env['XDG_DATA_HOME'] = savedData
  }
})

test('xdgConfigHome/xdgDataHome: Standardpfade ohne XDG_*-Variablen', () => {
  const savedConfig = process.env['XDG_CONFIG_HOME']
  const savedData = process.env['XDG_DATA_HOME']
  try {
    delete process.env['XDG_CONFIG_HOME']
    delete process.env['XDG_DATA_HOME']
    assert.equal(xdgConfigHome(), join(homedir(), '.config'))
    assert.equal(xdgDataHome(), join(homedir(), '.local', 'share'))
  } finally {
    if (savedConfig === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = savedConfig
    if (savedData === undefined) delete process.env['XDG_DATA_HOME']
    else process.env['XDG_DATA_HOME'] = savedData
  }
})

test('stableExePath: bevorzugt APPIMAGE, fällt sonst auf process.execPath zurück', () => {
  const saved = process.env['APPIMAGE']
  try {
    process.env['APPIMAGE'] = '/tmp/.mount_xyz/Foldwing.AppImage'
    assert.equal(stableExePath(), '/tmp/.mount_xyz/Foldwing.AppImage')

    delete process.env['APPIMAGE']
    assert.equal(stableExePath(), process.execPath)
  } finally {
    if (saved === undefined) delete process.env['APPIMAGE']
    else process.env['APPIMAGE'] = saved
  }
})

test('hasStableInstallPathLinux: APPIMAGE gesetzt -> immer true', () => {
  const saved = process.env['APPIMAGE']
  try {
    process.env['APPIMAGE'] = '/tmp/.mount_xyz/Foldwing.AppImage'
    assert.equal(hasStableInstallPathLinux(), true)
  } finally {
    if (saved === undefined) delete process.env['APPIMAGE']
    else process.env['APPIMAGE'] = saved
  }
})

// Ohne APPIMAGE hängt hasStableInstallPathLinux() vom tatsächlichen process.execPath
// dieses Hosts ab (/opt/, /usr/) -> host-abhängig, hier bewusst nicht geprüft.

test('isX11Session: auf Nicht-Linux-Hosts immer false, unabhängig von DISPLAY/XDG_SESSION_TYPE', () => {
  if (isLinux) return // host-abhängig, hier ausgelassen
  const savedType = process.env['XDG_SESSION_TYPE']
  const savedDisplay = process.env['DISPLAY']
  try {
    process.env['XDG_SESSION_TYPE'] = 'x11'
    process.env['DISPLAY'] = ':0'
    assert.equal(isX11Session(), false)
  } finally {
    if (savedType === undefined) delete process.env['XDG_SESSION_TYPE']
    else process.env['XDG_SESSION_TYPE'] = savedType
    if (savedDisplay === undefined) delete process.env['DISPLAY']
    else process.env['DISPLAY'] = savedDisplay
  }
})

test('sessionKind: XDG_SESSION_TYPE zählt zuerst', () => {
  assert.equal(sessionKind({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }), 'x11')
  assert.equal(sessionKind({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }), 'wayland')
  assert.equal(sessionKind({ XDG_SESSION_TYPE: 'Wayland', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), 'wayland')
})

test('sessionKind: ohne Sitzungstyp entscheiden DISPLAY/WAYLAND_DISPLAY', () => {
  assert.equal(sessionKind({ DISPLAY: ':0' }), 'x11')
  assert.equal(sessionKind({ XDG_SESSION_TYPE: 'tty', DISPLAY: ':0' }), 'x11') // startx
  assert.equal(sessionKind({ WAYLAND_DISPLAY: 'wayland-0' }), 'wayland')
  // Beides gesetzt (z. B. WSLg): offen lassen – weder X11-Fenstererkennung noch Wayland-Sperre.
  assert.equal(sessionKind({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), 'unknown')
  assert.equal(sessionKind({}), 'unknown')
})

test('isWaylandSession: auf Nicht-Linux-Hosts immer false', () => {
  if (isLinux) return // host-abhängig, hier ausgelassen
  const saved = process.env['XDG_SESSION_TYPE']
  try {
    process.env['XDG_SESSION_TYPE'] = 'wayland'
    assert.equal(isWaylandSession(), false)
  } finally {
    if (saved === undefined) delete process.env['XDG_SESSION_TYPE']
    else process.env['XDG_SESSION_TYPE'] = saved
  }
})
