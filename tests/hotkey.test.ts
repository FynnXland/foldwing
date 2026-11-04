import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureHotkey, type HotkeyKeyInput } from '../src/renderer/src/lib/hotkey'

function key(overrides: Partial<HotkeyKeyInput>): HotkeyKeyInput {
  return { key: 'a', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...overrides }
}

test('reiner Modifikator (z. B. Strg) -> pending', () => {
  assert.deepEqual(captureHotkey(key({ key: 'Control', ctrlKey: true })), { kind: 'pending' })
  assert.deepEqual(captureHotkey(key({ key: 'Shift', shiftKey: true })), { kind: 'pending' })
  assert.deepEqual(captureHotkey(key({ key: 'Alt', altKey: true })), { kind: 'pending' })
  assert.deepEqual(captureHotkey(key({ key: 'Meta', metaKey: true })), { kind: 'pending' })
})

test('Escape allein (ohne Zusatztaste) -> cancel', () => {
  assert.deepEqual(captureHotkey(key({ key: 'Escape' })), { kind: 'cancel' })
})

test('Escape MIT Zusatztaste ist kein Abbruch, sondern ein Accelerator', () => {
  const r = captureHotkey(key({ key: 'Escape', ctrlKey: true }))
  assert.deepEqual(r, { kind: 'accelerator', value: 'Control+Esc' })
})

test('Einzeltaste ohne Modifier -> rejected', () => {
  const r = captureHotkey(key({ key: 'a' }))
  assert.equal(r.kind, 'rejected')
  if (r.kind === 'rejected') {
    assert.match(r.reason, /Strg|Alt|Umschalt/)
  }
})

test('PrintScreen ohne Modifier ist erlaubt (Standalone-sicher)', () => {
  assert.deepEqual(captureHotkey(key({ key: 'PrintScreen' })), {
    kind: 'accelerator',
    value: 'PrintScreen'
  })
})

test('Funktionstasten (F1..F24) ohne Modifier sind erlaubt', () => {
  assert.deepEqual(captureHotkey(key({ key: 'F5' })), { kind: 'accelerator', value: 'F5' })
  assert.deepEqual(captureHotkey(key({ key: 'F24' })), { kind: 'accelerator', value: 'F24' })
})

test('F-ähnliche, aber ungültige Taste (F25, außerhalb F1..F24) -> nicht abbildbar -> pending', () => {
  // F_KEY-Regex deckt nur F1..F24 ab; "F25" fällt durch mainKeyName() als null durch.
  assert.deepEqual(captureHotkey(key({ key: 'F25' })), { kind: 'pending' })
})

test('Strg+Umschalt+S -> "Control+Shift+S"', () => {
  const r = captureHotkey(key({ key: 's', ctrlKey: true, shiftKey: true }))
  assert.deepEqual(r, { kind: 'accelerator', value: 'Control+Shift+S' })
})

test('Alt+Meta+Enter -> Reihenfolge Control/Alt/Shift/Super, Enter -> "Return"', () => {
  const r = captureHotkey(key({ key: 'Enter', altKey: true, metaKey: true }))
  assert.deepEqual(r, { kind: 'accelerator', value: 'Alt+Super+Return' })
})

test('unbekannte/nicht abbildbare Taste -> pending (weiter warten)', () => {
  // z. B. eine IME-Zusammensetzungstaste oder ein mehrstelliger, unbekannter Name
  assert.deepEqual(captureHotkey(key({ key: 'Unidentified' })), { kind: 'pending' })
})
