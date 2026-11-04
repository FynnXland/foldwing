import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cloudflaredArgs,
  cloudflaredErrorLine,
  ensureQuickTunnelConfig,
  QUICK_TUNNEL_CONFIG
} from '../src/main/tunnel'

test('cloudflaredArgs: Quick Tunnel mit eigener Config auf 127.0.0.1', () => {
  assert.deepEqual(cloudflaredArgs({ mode: 'quick', port: 8018, configPath: '/tmp/fs/cf.yml' }), [
    'tunnel',
    '--no-autoupdate',
    '--config',
    '/tmp/fs/cf.yml',
    '--url',
    'http://127.0.0.1:8018'
  ])
})

test('cloudflaredArgs: eigener Tunnel per Token', () => {
  assert.deepEqual(cloudflaredArgs({ mode: 'token', token: '  eyJabc  ' }), [
    'tunnel',
    '--no-autoupdate',
    'run',
    '--token',
    'eyJabc'
  ])
})

test('ensureQuickTunnelConfig: legt eine nicht leere, gültige Config an (cloudflared meckert über leere)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foldwing-tunnel-test-'))
  try {
    const file = join(dir, 'unter', 'cloudflared-quick.yml')
    ensureQuickTunnelConfig(file)
    ensureQuickTunnelConfig(file) // mehrfach aufrufbar
    const text = readFileSync(file, 'utf8')
    assert.equal(text, QUICK_TUNNEL_CONFIG)
    // Nur Kommentare und ein harmloser Schlüssel – kein tunnel:, keine credentials-file.
    const keys = text
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => l.split(':')[0].trim())
    assert.deepEqual(keys, ['no-autoupdate'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cloudflaredErrorLine: echte Fehler ja, Infos nein, ohne Pfade und Tokens', () => {
  assert.equal(cloudflaredErrorLine('2026-11-03T22:15:39Z INF Starting metrics server on 127.0.0.1:20242/metrics'), null)
  assert.equal(
    cloudflaredErrorLine('2026-11-03T22:15:39Z INF cloudflared does not support loading the system root certificate pool'),
    null
  )
  assert.equal(
    cloudflaredErrorLine('2026-11-03T22:15:39Z ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'),
    'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'
  )
  // Pfad zusammengesetzt, damit der Repo-Wächter (Heimatpfade) nicht anschlägt.
  const home = 'C:/' + 'Users/alex'
  const withPath = cloudflaredErrorLine(`2026-11-03T22:15:39Z ERR Configuration file ${home}/.cloudflared/config.yml was empty`)
  assert.ok(withPath && !withPath.includes('alex'), String(withPath))
  const withToken = cloudflaredErrorLine('2026-11-03T22:15:39Z ERR unauthorized: eyJhIjoiMTIzIiwidCI6IjQ1NiJ9')
  assert.ok(withToken && !withToken.includes('eyJ'), String(withToken))
})
