import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdleRelease } from '../src/main/capture-idle'

const DELAY = 60_000

/** Leerlauf-Freigabe mit steuerbarem „in Betrieb"-Zustand und Freigabe-Zähler. */
function setup(): {
  idle: ReturnType<typeof createIdleRelease>
  setInUse: (v: boolean) => void
  released: () => number
} {
  let inUse = false
  let released = 0
  const idle = createIdleRelease({
    delayMs: DELAY,
    inUse: () => inUse,
    release: () => {
      released++
    }
  })
  return { idle, setInUse: (v) => (inUse = v), released: () => released }
}

test('gibt nach Ablauf des Leerlaufs genau einmal frei', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = setup()
  s.idle.arm()
  assert.equal(s.idle.pending(), true)
  t.mock.timers.tick(DELAY - 1)
  assert.equal(s.released(), 0)
  t.mock.timers.tick(1)
  assert.equal(s.released(), 1)
  assert.equal(s.idle.pending(), false)
  t.mock.timers.tick(DELAY * 10)
  assert.equal(s.released(), 1)
})

test('neue Aufnahme (cancel) vor Ablauf verhindert die Freigabe', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = setup()
  s.idle.arm()
  t.mock.timers.tick(DELAY / 2)
  s.idle.cancel()
  assert.equal(s.idle.pending(), false)
  t.mock.timers.tick(DELAY * 2)
  assert.equal(s.released(), 0)
})

test('erneutes arm startet den Zeitgeber neu (Serienaufnahmen bleiben warm)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = setup()
  s.idle.arm()
  t.mock.timers.tick(DELAY - 10)
  s.idle.arm() // nächste Aufnahme vorbei
  t.mock.timers.tick(DELAY - 10)
  assert.equal(s.released(), 0)
  t.mock.timers.tick(10)
  assert.equal(s.released(), 1)
})

test('arm während Betrieb (Aufnahme läuft / Leiste offen) startet keinen Zeitgeber', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = setup()
  s.setInUse(true)
  s.idle.arm()
  assert.equal(s.idle.pending(), false)
  t.mock.timers.tick(DELAY * 3)
  assert.equal(s.released(), 0)
})

test('wird währenddessen wieder etwas gebraucht, gibt der Zeitgeber nicht frei', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = setup()
  s.idle.arm()
  s.setInUse(true) // z. B. Aufnahme gestartet, ohne dass jemand cancel() rief
  t.mock.timers.tick(DELAY)
  assert.equal(s.released(), 0)
  assert.equal(s.idle.pending(), false)
  // Deren Ende plant neu -> dann wird freigegeben.
  s.setInUse(false)
  s.idle.arm()
  t.mock.timers.tick(DELAY)
  assert.equal(s.released(), 1)
})

test('Ablauf wie in capture.ts: Aufnahme -> Aktionsleiste (Upload) -> zu -> Freigabe', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let busy = false
  let barOpen = false
  let released = 0
  const idle = createIdleRelease({
    delayMs: DELAY,
    inUse: () => busy || barOpen,
    release: () => {
      released++
    }
  })

  // beginCapture
  busy = true
  idle.cancel()
  // onConfirm -> closeOverlays (Aufnahme vorbei) -> openActionWindow
  busy = false
  idle.arm()
  barOpen = true
  idle.cancel()
  // Langer Upload bei offener Leiste: nichts wird abgeräumt.
  t.mock.timers.tick(DELAY * 5)
  assert.equal(released, 0)
  // Leiste zu ('closed') -> Leerlauf beginnt erst jetzt.
  barOpen = false
  idle.arm()
  t.mock.timers.tick(DELAY - 1)
  assert.equal(released, 0)
  t.mock.timers.tick(1)
  assert.equal(released, 1)
})
