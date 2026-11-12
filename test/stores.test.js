import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { gzipSync, deflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createListStore } from '../src/host/lists.js'
import { createRuleStore } from '../src/host/rules.js'

const tmp = async () => mkdtemp(path.join(process.cwd(), '.tmp-test-'))

test('list store: save / get / export / parse / diff', async (t) => {
  const dir = await tmp()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = createListStore({ dataDir: dir })
  const l = await s.save({ name: 'My List', mods: ['ludeon.rimworld', { packageId: 'a.b', name: 'AB', publishedFileId: '42' }] })
  assert.ok(l.id.startsWith('my-list-'))
  assert.equal((await s.get(l.id)).mods.length, 2)
  assert.equal((await s.summaries())[0].count, 2)

  const json = s.toText(l, 'rimlist')
  assert.equal(s.parseText(json).mods[1].publishedFileId, '42')
  const xml = s.toText(l, 'modsconfig', { gameVersionFull: '1.6.1' })
  assert.deepEqual(s.parseText(xml).mods.map((m) => m.packageId), ['ludeon.rimworld', 'a.b'])
  const md = s.toText(l, 'markdown')
  const fromMd = s.parseText(md)
  assert.equal(fromMd.name, 'My List')
  assert.deepEqual(fromMd.mods.map((m) => m.packageId), ['ludeon.rimworld', 'a.b'])
  assert.equal(fromMd.mods[1].publishedFileId, '42')
  assert.deepEqual(s.parseText(s.toText(l, 'ids')).mods.map((m) => m.packageId), ['ludeon.rimworld', 'a.b'])

  // workshop urls → steam: placeholders
  const ws = s.parseText('https://steamcommunity.com/sharedfiles/filedetails/?id=2009463077\nsome.mod')
  assert.deepEqual(ws.mods.map((m) => m.packageId).sort(), ['some.mod', 'steam:2009463077'])
  // RimPy-style keyed JSON
  assert.equal(s.parseText('{"a.b":{"name":"AB","publishedfileid":"7"}}').mods[0].publishedFileId, '7')
  assert.throws(() => s.parseText('   '), /empty/)

  const d = s.diff(['core', 'a', 'b', 'c', 'd'], ['core', 'b', 'a', 'd', 'e'])
  assert.deepEqual(d.added, ['e'])
  assert.deepEqual(d.removed, ['c'])
  assert.equal(d.reordered.length, 1)
  assert.equal(d.same, 3)
  assert.ok(await s.remove(l.id))
  assert.equal((await s.all()).length, 0)
})

test('rule store: normalize, user rules, provenance, nvw', async (t) => {
  const dir = await tmp()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const payloads = {
    communityRules: JSON.stringify({ timestamp: 1, rules: { 'X.Y': { loadAfter: { 'A.B': { name: ['AB'] } }, loadBottom: { value: true, comment: 'last' } }, 'top.mod': { loadTop: { value: true } } } }),
    steamDB: JSON.stringify({ version: 9, database: { 123: { packageId: 'A.B', name: 'AB', url: 'u', gameVersions: ['1.6'], dependencies: { 456: ['Dep', 'url'] } }, 456: { packageId: 'dep.mod', name: 'Dep' } } }),
    nvw: '<ModIdsToFix><li>Old.Mod</li></ModIdsToFix>',
    uti: JSON.stringify({ version: 'v', rules: [{ oldWorkshopId: '111', oldName: 'Old', oldPackageId: 'Old.Mod', newWorkshopId: '222', newName: 'Old (Continued)', newAuthor: 'Mlie', newPackageId: 'mlie.old', newVersions: ['1.6'] }] }),
    versions: JSON.stringify({ depots: {}, versions: { linux: [{ manifest_id: '1', version: '1.6.4871 rev598', status: 'OK', dlcs: {} }] } }),
  }
  const pick = (url) => (url.includes('communityRules') ? payloads.communityRules : url.includes('steamDB') ? payloads.steamDB : url.includes('ModIdsToFix') ? payloads.nvw : url.includes('replacements') ? gzipSync(Buffer.from(payloads.uti)) : payloads.versions)
  const fetchImpl = async (url) => {
    const body = pick(url)
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
    return { ok: true, text: async () => buf.toString('utf8'), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  }
  const r = createRuleStore({ dataDir: dir, fetchImpl })
  const st = await r.ensure({ major: '1.6', maxAgeHours: 0, force: true })
  assert.equal(st.community.rules, 2)
  assert.equal(st.steam.entries, 2)
  assert.equal(st.noVersionWarning.ids, 1)
  assert.equal(st.useThisInstead.entries, 1)
  assert.equal(st.versions.latest, '1.6.4871 rev598')
  assert.equal(r.replacementFor({ publishedFileId: '111' }).newPfid, '222')
  assert.equal(r.replacementFor({ packageId: 'OLD.mod' }).newName, 'Old (Continued)')
  // a re-upload that keeps the packageId must not flag the recommended copy itself (HugsLib case)
  r.state.useThisInstead.byOldPid.set('same.id', { oldPfid: '777', newPfid: '888', newPackageId: 'same.id' })
  assert.equal(r.replacementFor({ publishedFileId: '888', packageId: 'same.id' }), undefined)
  assert.equal(r.replacementFor({ publishedFileId: '999', packageId: 'Old.Mod' }), undefined)
  assert.equal(r.replacementFor({ packageId: 'same.id' }), undefined)
  assert.ok(r.rulesFor('x.y').loadAfter['a.b'])
  assert.equal(r.rulesFor('x.y').loadBottom.source, 'community')
  assert.ok(r.rulesFor('TOP.mod').loadTop)
  assert.equal(r.steamByPid('a.b').pfid, '123')
  assert.equal(r.steamByPfid('123').dependencies['456'], 'Dep')
  assert.ok(r.nvwCovers('old.mod'))

  await r.addUserRule({ packageId: 'x.y', kind: 'loadBefore', target: 'a.b', comment: 'mine' })
  const m = r.rulesFor('x.y')
  assert.ok(m.loadBefore['a.b'])
  assert.equal(m.loadBefore['a.b'].source, 'user')
  assert.ok(m.loadAfter['a.b'], 'community rule still visible (sorter resolves by priority)')
  await r.addUserRule({ packageId: 'x.y', kind: 'loadTop' })
  assert.ok(r.rulesFor('x.y').loadTop)
  assert.equal(r.rulesFor('x.y').loadTop.source, 'user')
  await r.removeUserRule({ packageId: 'x.y', kind: 'loadBefore', target: 'a.b' })
  await r.removeUserRule({ packageId: 'x.y', kind: 'loadTop' })
  assert.equal(Object.keys(r.userRules()).length, 0)
  assert.equal(r.rulesFor('x.y').loadBottom.source, 'community')

  // import/export user rules (RimSort format)
  const n = await r.importUserRules({ timestamp: 0, rules: { 'oa.ratkin': { loadAfter: { 'ratkin.gene': { name: ['RGE'], comment: 'works' } } } } })
  assert.equal(n, 1)
  assert.equal(r.rulesFor('oa.ratkin').loadAfter['ratkin.gene'].source, 'user')
  assert.ok(r.exportUserRules().rules['oa.ratkin'].loadAfter['ratkin.gene'])

  // cache survives a new store without network
  const r2 = createRuleStore({ dataDir: dir, fetchImpl: async () => { throw new Error('offline') } })
  const st2 = await r2.ensure({ major: '1.6', maxAgeHours: 1e9 })
  assert.equal(st2.community.rules, 2)
  r2.setEnabled('community', false)
  assert.equal(Object.keys(r2.rulesFor('x.y').loadAfter).length, 0)
  assert.equal((await r2.status()).community.mode, 'none')

  // local-file source (RimSort layout) and zip source
  const localDir = path.join(dir, 'rimsort')
  await mkdir(path.join(localDir, 'dbs'), { recursive: true })
  await writeFile(path.join(localDir, 'dbs', 'communityRules.json'), JSON.stringify({ timestamp: 2, rules: { 'local.only': { loadTop: { value: true } } } }))
  const r3 = createRuleStore({ dataDir: dir, fetchImpl: async () => { throw new Error('offline') } })
  r3.configure({ community: { mode: 'local', path: path.join(localDir, 'dbs', 'communityRules.json') }, steam: { mode: 'none' }, noVersionWarning: { mode: 'none' }, useThisInstead: { mode: 'none' }, versions: { mode: 'none' } })
  const st3 = await r3.ensure({ major: '1.6', maxAgeHours: 1e9 })
  assert.equal(st3.community.rules, 1)
  assert.ok(r3.rulesFor('local.only').loadTop)
  assert.equal(st3.steam.entries, 0)
  const zipBuf = makeZip('Community-Rules-Database-main/communityRules.json', JSON.stringify({ timestamp: 3, rules: { 'from.zip': { loadBottom: { value: true } } } }))
  const r4 = createRuleStore({ dataDir: dir, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength) }) })
  r4.configure({ community: { mode: 'url', url: 'https://example/x.zip' }, steam: { mode: 'none' }, noVersionWarning: { mode: 'none' }, useThisInstead: { mode: 'none' }, versions: { mode: 'none' } })
  await r4.ensure({ major: '1.6', force: true })
  assert.ok(r4.rulesFor('from.zip').loadBottom)
})

/** Build a one-file zip (deflate) for tests. */
function makeZip(name, content) {
  const data = Buffer.from(content)
  const comp = deflateRawSync(data)
  const crc = crc32(data)
  const nameBuf = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(0, 42)
  const cdOffset = local.length + nameBuf.length + comp.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + nameBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16)
  return Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd])
}
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

