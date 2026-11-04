import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rectFromPoints,
  pointInRect,
  topmostWindowAt,
  clampToBounds,
  isNearTopEdge,
  isDrag,
  toPhysicalRect,
  insetRect,
  type DetectedWindow
} from '../src/main/capture-geometry'

test('rectFromPoints: normalisiert unabhängig von der Zugrichtung', () => {
  assert.deepEqual(rectFromPoints(10, 10, 50, 40), { x: 10, y: 10, width: 40, height: 30 })
  assert.deepEqual(rectFromPoints(50, 40, 10, 10), { x: 10, y: 10, width: 40, height: 30 })
  assert.deepEqual(rectFromPoints(5, 20, 5, 20), { x: 5, y: 20, width: 0, height: 0 })
})

test('pointInRect: inklusive Kanten', () => {
  const r = { x: 10, y: 10, width: 20, height: 20 }
  assert.equal(pointInRect(10, 10, r), true) // linke obere Ecke
  assert.equal(pointInRect(30, 30, r), true) // rechte untere Ecke
  assert.equal(pointInRect(20, 20, r), true) // Mitte
  assert.equal(pointInRect(9, 20, r), false)
  assert.equal(pointInRect(31, 20, r), false)
})

test('topmostWindowAt: erster Treffer in Z-Reihenfolge gewinnt', () => {
  const windows: DetectedWindow[] = [
    { title: 'vorne', x: 0, y: 0, width: 100, height: 100 },
    { title: 'hinten (überlappt komplett)', x: 0, y: 0, width: 200, height: 200 }
  ]
  assert.deepEqual(topmostWindowAt(50, 50, windows), { x: 0, y: 0, width: 100, height: 100 })
})

test('topmostWindowAt: Fenster ohne Fläche werden übersprungen', () => {
  const windows: DetectedWindow[] = [
    { title: 'leer', x: 0, y: 0, width: 0, height: 100 },
    { title: 'gültig', x: 0, y: 0, width: 100, height: 100 }
  ]
  assert.deepEqual(topmostWindowAt(50, 50, windows), { x: 0, y: 0, width: 100, height: 100 })
})

test('topmostWindowAt: kein Treffer -> null', () => {
  const windows: DetectedWindow[] = [{ title: 'weit weg', x: 500, y: 500, width: 10, height: 10 }]
  assert.equal(topmostWindowAt(0, 0, windows), null)
})

test('clampToBounds: negative Ränder werden auf 0 gezogen', () => {
  assert.deepEqual(clampToBounds({ x: -10, y: -5, width: 50, height: 50 }, 1000, 800), {
    x: 0,
    y: 0,
    width: 50,
    height: 50
  })
})

test('clampToBounds: Überstand über den Monitor wird abgeschnitten', () => {
  assert.deepEqual(clampToBounds({ x: 900, y: 700, width: 300, height: 300 }, 1000, 800), {
    x: 900,
    y: 700,
    width: 100,
    height: 100
  })
})

test('isNearTopEdge: Standard-Schwelle 8px', () => {
  assert.equal(isNearTopEdge(0), true)
  assert.equal(isNearTopEdge(8), true)
  assert.equal(isNearTopEdge(9), false)
})

test('isNearTopEdge: eigene Schwelle', () => {
  assert.equal(isNearTopEdge(20, 25), true)
  assert.equal(isNearTopEdge(26, 25), false)
})

test('isDrag: Standard-Mindestdistanz 4px (inklusive)', () => {
  assert.equal(isDrag(0, 0, 4, 0), true)
  assert.equal(isDrag(0, 0, 0, 4), true)
  assert.equal(isDrag(0, 0, 3, 3), false)
  assert.equal(isDrag(0, 0, 0, 0), false)
})

test('isDrag: eigene Mindestdistanz', () => {
  assert.equal(isDrag(0, 0, 10, 0, 12), false)
  assert.equal(isDrag(0, 0, 12, 0, 12), true)
})

test('toPhysicalRect: skaliert und rundet', () => {
  assert.deepEqual(toPhysicalRect({ x: 10, y: 20, width: 30, height: 40 }, 1.5), {
    x: 15,
    y: 30,
    width: 45,
    height: 60
  })
})

test('toPhysicalRect: rundet .5 auf (JS Math.round)', () => {
  // 3 * 1.5 = 4.5 -> Math.round(4.5) = 5
  assert.deepEqual(toPhysicalRect({ x: 3, y: 3, width: 3, height: 3 }, 1.5), {
    x: 5,
    y: 5,
    width: 5,
    height: 5
  })
})

test('insetRect: zieht das Rechteck allseitig ein', () => {
  assert.deepEqual(insetRect({ x: 10, y: 10, width: 100, height: 100 }, 3), {
    x: 13,
    y: 13,
    width: 94,
    height: 94
  })
})

test('insetRect: by <= 0 lässt das Rechteck unverändert', () => {
  const r = { x: 10, y: 10, width: 100, height: 100 }
  assert.deepEqual(insetRect(r, 0), r)
  assert.deepEqual(insetRect(r, -5), r)
})

test('insetRect: zu kleine Fenster bleiben unverändert', () => {
  const r = { x: 0, y: 0, width: 5, height: 5 }
  assert.deepEqual(insetRect(r, 3), r) // width(5) <= by*2+4(10)
})

test('insetRect: Grenzfall width = by*2+4 bleibt unverändert', () => {
  const by = 2
  const r = { x: 0, y: 0, width: by * 2 + 4, height: 50 } // width = 8
  assert.deepEqual(insetRect(r, by), r)
})

test('insetRect: width = by*2+5 (knapp über der Grenze) wird eingezogen', () => {
  const by = 2
  const r = { x: 0, y: 0, width: by * 2 + 5, height: 50 } // width = 9
  assert.deepEqual(insetRect(r, by), { x: 2, y: 2, width: 5, height: 46 })
})
