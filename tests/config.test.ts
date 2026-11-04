import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, migrateConfig, pickLanAddress, DEFAULTS, RETIRED_KEYS, CONFIG_VERSION } from '../src/main/config'

test('migrateConfig: leere/ungültige Eingabe -> Standard (Relay, Updates an)', () => {
  for (const input of [undefined, null, 42, 'x', []]) {
    const { config } = migrateConfig(input)
    assert.equal(config.linkMode, 'relay')
    assert.deepEqual(config.updates, { auto: true })
    assert.deepEqual(config.relay, { deviceId: '', secretEnc: '', noticeAccepted: false })
    assert.equal(config.configVersion, CONFIG_VERSION)
  }
  assert.deepEqual(migrateConfig({ configVersion: CONFIG_VERSION }).config, DEFAULTS)
})

test('Migration: Team-Mitglied -> relay, Team-Token und Team-Adresse verworfen', () => {
  const { config, changed } = migrateConfig({
    configVersion: 2,
    teamName: 'alex',
    publicBaseUrl: 'https://share-alex.example.com',
    tunnel: { enabled: true, mode: 'token', name: 'foldwing', token: 'eyJ-team-token', cloudflaredPath: '' }
  })
  assert.equal(changed, true)
  assert.equal(config.linkMode, 'relay')
  assert.equal(config.publicBaseUrl, '')
  assert.equal(config.tunnel.token, '')
  assert.ok(!('teamName' in config))
})

test('Migration: eigener Token + Adresse -> domain, beides bleibt', () => {
  const { config } = migrateConfig({
    configVersion: 2,
    publicBaseUrl: 'https://share.example.com',
    tunnel: { enabled: true, mode: 'token', name: '', token: 'eyJ-eigener-token', cloudflaredPath: 'C:\\cf.exe' }
  })
  assert.equal(config.linkMode, 'domain')
  assert.equal(config.publicBaseUrl, 'https://share.example.com')
  assert.deepEqual(config.tunnel, { token: 'eyJ-eigener-token', cloudflaredPath: 'C:\\cf.exe' })
})

test('Migration: benannter Tunnel, nur Adresse oder nur Token -> relay', () => {
  for (const old of [
    { publicBaseUrl: 'https://share.example.com', tunnel: { enabled: true, mode: 'name', name: 'foldwing', token: '' } },
    { publicBaseUrl: 'https://share.example.com' },
    { tunnel: { token: 'eyJ-nur-token' } },
    {}
  ]) {
    assert.equal(migrateConfig({ configVersion: 2, ...old }).config.linkMode, 'relay', JSON.stringify(old))
  }
})

test('Migration: abgeschaffte Schlüssel fallen weg, auch tunnel.mode/name/enabled', () => {
  const { config, changed } = migrateConfig({
    configVersion: 2,
    provisioning: { apiTokenEnc: 'x' },
    license: 'x',
    deviceId: 'alt',
    serverInBackground: true,
    contextMenuPath: 'x',
    teamName: '',
    tunnel: { enabled: false, mode: 'name', name: 'foldwing', token: '', cloudflaredPath: '' }
  })
  assert.equal(changed, true)
  const flat = JSON.stringify(config)
  for (const key of RETIRED_KEYS) {
    const [top, sub] = key.split('.')
    if (sub) assert.ok(!(sub in (config as unknown as Record<string, Record<string, unknown>>)[top]), key)
    else assert.ok(!(top in config), key)
  }
  assert.ok(!flat.includes('apiTokenEnc'))
  for (const k of ['teamName', 'tunnel.mode', 'tunnel.name', 'tunnel.enabled']) {
    assert.ok((RETIRED_KEYS as readonly string[]).includes(k), `${k} steht in der Liste`)
  }
})

test('Migration: übrige Einstellungen bleiben, Config v1 hebt closeToTray an', () => {
  const { config } = migrateConfig({
    port: 8018,
    defaultTtlHours: 24,
    closeToTray: false,
    autostart: false,
    scanUploads: false,
    capture: { hotkey: 'Control+Shift+S', magnifier: false },
    ui: { theme: 'dark', previews: false, bannerDismissed: true }
  })
  assert.equal(config.port, 8018)
  assert.equal(config.defaultTtlHours, 24)
  assert.equal(config.closeToTray, true, 'v1 -> v2: im Hintergrund weiterlaufen')
  assert.equal(config.autostart, false)
  assert.equal(config.scanUploads, false)
  assert.equal(config.capture.hotkey, 'Control+Shift+S')
  assert.equal(config.capture.magnifier, false)
  assert.equal(config.capture.enabled, true)
  assert.deepEqual(config.ui, { theme: 'dark', previews: false, bannerDismissed: true })
})

test('Config v3: Betriebsart, Relay-Identität und Updates werden übernommen; Unsinn fällt zurück', () => {
  const ok = migrateConfig({
    configVersion: 3,
    linkMode: 'lan',
    relay: { deviceId: 'Ab3dEf7h', secretEnc: 'safe:xyz', noticeAccepted: true },
    updates: { auto: false }
  })
  assert.equal(ok.config.linkMode, 'lan')
  assert.deepEqual(ok.config.relay, { deviceId: 'Ab3dEf7h', secretEnc: 'safe:xyz', noticeAccepted: true })
  assert.equal(ok.config.updates.auto, false)

  const bad = migrateConfig({
    configVersion: 3,
    linkMode: 'team',
    relay: { deviceId: 'zu-kurz', secretEnc: 'safe:xyz' },
    updates: { auto: 'ja' }
  })
  assert.equal(bad.config.linkMode, 'relay')
  assert.deepEqual(bad.config.relay, { deviceId: '', secretEnc: '', noticeAccepted: false })
  assert.equal(bad.config.updates.auto, true)
})

test('migrateConfig: eine aktuelle Config gilt als unverändert (kein unnötiges Schreiben)', () => {
  const { config } = migrateConfig({ configVersion: 2, port: 8018 })
  const again = migrateConfig(JSON.parse(JSON.stringify(config)))
  assert.equal(again.changed, false)
  assert.deepEqual(again.config, config)
})

test('ConfigStore: migriert die Datei beim Laden und schreibt sie bereinigt zurück', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foldwing-config-test-'))
  try {
    const file = join(dir, 'foldwing-config.json')
    writeFileSync(
      file,
      JSON.stringify({
        configVersion: 2,
        teamName: 'alex',
        publicBaseUrl: 'https://share-alex.example.com',
        tunnel: { enabled: true, mode: 'token', name: 'x', token: 'eyJ-team', cloudflaredPath: '' },
        port: 8018
      })
    )
    const store = new ConfigStore(dir)
    const cfg = await store.load()
    assert.equal(cfg.linkMode, 'relay')
    assert.equal(cfg.port, 8018)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.configVersion, CONFIG_VERSION)
    assert.ok(!('teamName' in onDisk))
    assert.ok(!('mode' in onDisk.tunnel) && !('enabled' in onDisk.tunnel) && !('name' in onDisk.tunnel))
    assert.equal(onDisk.tunnel.token, '')

    // Kaputte Datei -> Standard, keine Ausnahme.
    writeFileSync(file, '{ kaputt')
    assert.equal((await new ConfigStore(dir).load()).linkMode, 'relay')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pickLanAddress: echtes Heimnetz vor virtuellen Karten, nie 169.254.x.x', () => {
  const v4 = (address: string, internal = false) => ({ family: 'IPv4', address, internal })
  assert.equal(
    pickLanAddress({
      'Ethernet 3': [v4('169.254.83.107')],
      'vEthernet (WSL)': [v4('172.20.16.1')],
      Tailscale: [v4('100.101.102.103')],
      WLAN: [{ family: 'IPv6', address: 'fe80::1', internal: false }, v4('192.168.178.30')],
      Loopback: [v4('127.0.0.1', true)]
    }),
    '192.168.178.30'
  )
  assert.equal(pickLanAddress({ 'vEthernet (WSL)': [v4('172.20.16.1')], Tailscale: [v4('100.64.0.2')] }), '172.20.16.1')
  assert.equal(pickLanAddress({ Tailscale: [v4('100.64.0.2')] }), '100.64.0.2')
  assert.equal(pickLanAddress({ eth0: [{ family: 4, address: '10.0.0.5', internal: false }] }), '10.0.0.5')
  assert.equal(pickLanAddress({ 'Ethernet 3': [v4('169.254.1.1')], lo: [v4('127.0.0.1', true)] }), null)
})
