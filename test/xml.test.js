import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAbout, parseModsConfig, buildModsConfig, parseIdBlob, pid } from '../src/host/xml.js'

test('parseAbout handles versioned overrides, dependencies, loose casing', () => {
  const m = parseAbout(
    `<?xml version="1.0"?><ModMetaData>
      <packageId>Foo.Bar</packageId><name>Foo</name><author>A</author>
      <supportedVersions><li>1.5</li><li>1.6</li></supportedVersions>
      <loadAfter><li>brrainz.harmony</li></loadAfter>
      <loadAfterByVersion><v1.6><li>brrainz.harmony</li><li>x.y</li></v1.6></loadAfterByVersion>
      <modDependencies><li><packageId>brrainz.harmony</packageId><displayName>Harmony</displayName><steamWorkshopUrl>steam://url/CommunityFilePage/2009463077</steamWorkshopUrl></li></modDependencies>
      <incompatibleWith><li>bad.mod</li></incompatibleWith>
    </ModMetaData>`,
    '1.6',
  )
  assert.equal(m.packageId, 'Foo.Bar')
  assert.deepEqual(m.supportedVersions, ['1.5', '1.6'])
  assert.deepEqual(m.loadAfter, ['brrainz.harmony', 'x.y'])
  assert.equal(m.modDependencies[0].packageId, 'brrainz.harmony')
  assert.equal(m.modDependencies[0].steamWorkshopUrl, 'steam://url/CommunityFilePage/2009463077')
  assert.deepEqual(m.incompatibleWith, ['bad.mod'])
  const m15 = parseAbout('<ModMetaData><packageId>a.b</packageId><loadAfter><li>q</li></loadAfter><loadAfterByVersion><v1.6><li>z</li></v1.6></loadAfterByVersion></ModMetaData>', '1.5')
  assert.deepEqual(m15.loadAfter, ['q'])
})

test('ModsConfig round-trips', () => {
  const xml = buildModsConfig({ version: '1.6.4871 rev598', activeMods: ['brrainz.harmony', 'ludeon.rimworld'], knownExpansions: ['ludeon.rimworld.royalty'] })
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>/)
  const cfg = parseModsConfig(xml)
  assert.equal(cfg.version, '1.6.4871 rev598')
  assert.deepEqual(cfg.activeMods, ['brrainz.harmony', 'ludeon.rimworld'])
  assert.deepEqual(cfg.knownExpansions, ['ludeon.rimworld.royalty'])
  const empty = parseModsConfig(buildModsConfig({ version: 'x', activeMods: [], knownExpansions: [] }))
  assert.deepEqual(empty.activeMods, [])
})

test('parseIdBlob accepts xml fragments and text lists', () => {
  assert.deepEqual(parseIdBlob('<activeMods><li>a.b</li><li>c.d</li></activeMods>'), ['a.b', 'c.d'])
  assert.deepEqual(parseIdBlob('a.b\nc.d, e.f  g.h'), ['a.b', 'c.d', 'e.f', 'g.h'])
  assert.equal(pid('  Foo.BAR '), 'foo.bar')
})

test('buildModsConfig writes lowercase, de-duplicated ids (RimWorld is case-sensitive here)', () => {
  const xml = buildModsConfig({ version: 'v', activeMods: ['Ludeon.RimWorld', 'brrainz.Harmony', 'ludeon.rimworld'], knownExpansions: ['Ludeon.RimWorld.Royalty'] })
  assert.ok(!/[A-Z]/.test(xml.replace(/<\/?[A-Za-z]+>|<\?xml[^>]*>/g, '')))
  assert.deepEqual(parseModsConfig(xml).activeMods, ['ludeon.rimworld', 'brrainz.harmony'])
})
