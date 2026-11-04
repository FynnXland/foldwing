import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanFile, type ScanCommand } from '../src/main/scanner'

/** Simuliert einen Scanner über `node -e "process.exit(N)"` – exakt kontrollierbarer Exit-Code. */
function nodeExitCommand(code: number): ScanCommand {
  return {
    bin: process.execPath,
    args: () => ['-e', `process.exit(${code})`],
    cleanCode: 0,
    infectedCode: 2
  }
}

test('scanFile: Exit-Code 0 -> "clean"', async () => {
  const result = await scanFile('irgendein-pfad.bin', 5000, nodeExitCommand(0))
  assert.equal(result, 'clean')
})

test('scanFile: Exit-Code == infectedCode (2) -> "infected"', async () => {
  const result = await scanFile('irgendein-pfad.bin', 5000, nodeExitCommand(2))
  assert.equal(result, 'infected')
})

test('scanFile: sonstiger Exit-Code (weder clean noch infected) -> "unavailable"', async () => {
  const result = await scanFile('irgendein-pfad.bin', 5000, nodeExitCommand(7))
  assert.equal(result, 'unavailable')
})

test('scanFile: nicht existierendes Scanner-Binary -> "unavailable"', { timeout: 10_000 }, async () => {
  const cmd: ScanCommand = {
    bin: join(tmpdir(), 'foldwing-test-definitely-missing-binary-xyz'),
    args: () => [],
    cleanCode: 0,
    infectedCode: 1
  }
  const result = await scanFile('irgendein-pfad.bin', 5000, cmd)
  assert.equal(result, 'unavailable')
})

test('scanFile: Timeout killt den Prozess -> "unavailable"', { timeout: 10_000 }, async () => {
  const cmd: ScanCommand = {
    bin: process.execPath,
    // Läuft absichtlich viel länger als das Timeout unten.
    args: () => ['-e', 'setTimeout(() => {}, 60000)'],
    cleanCode: 0,
    infectedCode: 1
  }
  const start = Date.now()
  const result = await scanFile('irgendein-pfad.bin', 300, cmd)
  const elapsed = Date.now() - start
  assert.equal(result, 'unavailable')
  assert.ok(elapsed < 5000, `sollte durch das Timeout schnell zurückkommen, dauerte ${elapsed}ms`)
})
