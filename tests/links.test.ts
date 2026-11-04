import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lanLinks, relayLinks, routeSharePath, normalizeBaseUrl } from '../src/main/links'

const D = 'Ab3dEf7h'
const S = 'Q1w2E3r4T5'
const T = D + S

test('lanLinks: die bisherigen /s/- und /f/-Pfade', () => {
  const l = lanLinks(S)
  assert.equal(l.family, 'lan')
  assert.equal(l.page(), `/s/${S}`)
  assert.equal(l.page('abc123'), `/s/${S}/abc123`)
  assert.equal(l.raw(), `/f/${S}`)
  assert.equal(l.raw('abc123'), `/f/${S}/abc123`)
  assert.equal(l.fontBase, '/_font')
  assert.equal(l.token, undefined)
})

test('relayLinks: /<T>, /<T>/<F>, /<T>/d, /<T>/<F>/d, /<T>/_font', () => {
  const l = relayLinks(D, S)
  assert.equal(l.family, 'relay')
  assert.equal(l.page(), `/${T}`)
  assert.equal(l.page('abc123'), `/${T}/abc123`)
  assert.equal(l.raw(), `/${T}/d`)
  assert.equal(l.raw('abc123'), `/${T}/abc123/d`)
  assert.equal(l.fontBase, `/${T}/_font`)
  assert.equal(l.token, T)
  assert.notEqual(l.cacheKey, lanLinks(S).cacheKey, 'Cache-Schlüssel trennt die Familien')
})

test('Link-Builder lassen nur base62 durch (manipulierte Metadaten)', () => {
  assert.equal(lanLinks('ab"><x').page(), '/s/abx')
  assert.equal(relayLinks(D, S).page('"/../'), `/${T}/`)
})

test('routeSharePath: LAN-Familie', () => {
  assert.deepEqual(
    (({ kind, shareId, fid }) => ({ kind, shareId, fid }))(routeSharePath(`/s/${S}`, D) as never),
    { kind: 'page', shareId: S, fid: undefined }
  )
  const r = routeSharePath(`/f/${S}/abc123`, null)
  assert.ok(r && r.kind === 'raw')
  assert.equal(r.fid, 'abc123')
  assert.equal(r.links.family, 'lan')
  assert.deepEqual(routeSharePath('/_font/Geist-Variable.woff2', null), { kind: 'font', font: 'Geist-Variable' })
  assert.equal(routeSharePath('/_font/evil.woff2', null), null)
  assert.equal(routeSharePath('/s/a-b', D), null)
  assert.equal(routeSharePath(`/s/${S}/x/y`, D), null)
})

test('routeSharePath: Relay-Familie fürs eigene Gerät', () => {
  const page = routeSharePath(`/${T}`, D)
  assert.ok(page && page.kind === 'page')
  assert.equal(page.shareId, S)
  assert.equal(page.links.family, 'relay')
  assert.equal(page.fid, undefined)

  const part = routeSharePath(`/${T}/abc123`, D)
  assert.ok(part && part.kind === 'page' && part.fid === 'abc123')

  const raw = routeSharePath(`/${T}/d`, D)
  assert.ok(raw && raw.kind === 'raw' && raw.fid === undefined)

  const partRaw = routeSharePath(`/${T}/abc123/d`, D)
  assert.ok(partRaw && partRaw.kind === 'raw' && partRaw.fid === 'abc123')

  assert.deepEqual(routeSharePath(`/${T}/_font/GeistMono-Variable.woff2`, D), {
    kind: 'font',
    font: 'GeistMono-Variable'
  })
})

test('routeSharePath: fremdes Gerät und ohne eigene ID -> foreign; Unsinn -> null', () => {
  assert.deepEqual(routeSharePath(`/Fremd123${S}`, D), { kind: 'foreign' })
  assert.deepEqual(routeSharePath(`/Fremd123${S}/d`, D), { kind: 'foreign' })
  assert.deepEqual(routeSharePath(`/${T}`, null), { kind: 'foreign' })
  assert.deepEqual(routeSharePath(`/${T}`, 'kaputt'), { kind: 'foreign' })
  for (const p of [
    `/${T}/x`,
    `/${T}/abcdefg`,
    `/${T}/abc12`,
    `/${T}/abc123/e`,
    `/${T}/abc123/d/x`,
    `/${T}/_font/x.woff2`,
    `/${T}x`,
    `/${T.slice(1)}`,
    '/api',
    '/',
    'kein-pfad'
  ]) {
    assert.equal(routeSharePath(p, D), null, p)
  }
})

test('normalizeBaseUrl: ergänzt https, kürzt Schrägstriche, lehnt Unbrauchbares ab', () => {
  assert.equal(normalizeBaseUrl(''), '')
  assert.equal(normalizeBaseUrl('  '), '')
  assert.equal(normalizeBaseUrl('share.example.com'), 'https://share.example.com')
  assert.equal(normalizeBaseUrl('https://share.example.com///'), 'https://share.example.com')
  assert.equal(normalizeBaseUrl('http://share.example.com/pfad/'), 'http://share.example.com/pfad')
  for (const bad of ['javascript:alert(1)', 'ftp://example.com', 'https://u:p@example.com', 'https://example.com/?x=1', 'localhost', 'https://exa mple.com']) {
    assert.equal(normalizeBaseUrl(bad), null, bad)
  }
})
