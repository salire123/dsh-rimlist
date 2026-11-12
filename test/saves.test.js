import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseSaveMeta, readSaveMeta, splitSaveName, createSaveStore, defaultSavesDir } from '../src/host/saves.js'

const head = (mods) => `<?xml version="1.0" encoding="utf-8"?>
<savegame>
\t<meta>
\t\t<gameVersion>1.6.4871 rev598</gameVersion>
\t\t<modIds>${mods.map((m) => `<li>${m[0]}</li>`).join('')}</modIds>
\t\t<modSteamIds>${mods.map((m) => `<li>${m[1]}</li>`).join('')}</modSteamIds>
\t\t<modNames>${mods.map((m) => `<li>${m[2]}</li>`).join('')}</modNames>
\t</meta>
\t<scenario><name>x</name></scenario>`

test('parseSaveMeta reads ids, names and workshop ids (0 = none)', () => {
  const m = parseSaveMeta(head([['brrainz.harmony', '2009463077', 'Harmony'], ['ludeon.rimworld', '0', 'Core'], ['a.b', '0', 'Tom &amp; Jerry']]))
  assert.equal(m.gameVersion, '1.6.4871 rev598')
  assert.deepEqual(m.mods, [
    { packageId: 'brrainz.harmony', name: 'Harmony', publishedFileId: '2009463077' },
    { packageId: 'ludeon.rimworld', name: 'Core', publishedFileId: undefined },
    { packageId: 'a.b', name: 'Tom & Jerry', publishedFileId: undefined },
  ])
  assert.throws(() => parseSaveMeta('<savegame><game/></savegame>'), /no <meta>/)
})

test('save names: folder##name split and default Saves dir', () => {
  assert.deepEqual(splitSaveName('NotPlay##Autosave-1 #3'), { folder: 'NotPlay', title: 'Autosave-1 #3' })
  assert.deepEqual(splitSaveName('Colony'), { folder: '', title: 'Colony' })
  assert.equal(defaultSavesDir(path.join('x', 'RimWorld by Ludeon Studios', 'Config')), path.join('x', 'RimWorld by Ludeon Studios', 'Saves'))
})

test('store lists saves, reads only the header of big files, refuses traversal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rl-saves-'))
  try {
    const many = Array.from({ length: 3000 }, (_, i) => [`mod.n${i}`, '0', `Mod ${i}`]) // header > one 64 KB chunk
    await writeFile(path.join(dir, 'Big##Colony.rws'), head(many) + '<x>' + 'y'.repeat(2_000_000) + '</x></savegame>')
    await writeFile(path.join(dir, 'broken.rws'), 'not xml')
    await writeFile(path.join(dir, 'notes.txt'), 'ignore me')
    assert.equal((await readSaveMeta(path.join(dir, 'Big##Colony.rws'))).mods.length, 3000)
    const store = createSaveStore()
    const list = await store.list(dir)
    assert.equal(list.length, 2)
    const big = list.find((s) => s.name === 'Big##Colony.rws')
    assert.equal(big.modCount, 3000)
    assert.equal(big.folder, 'Big')
    assert.ok(list.find((s) => s.name === 'broken.rws').error)
    const d = await store.get(dir, 'Big##Colony')
    assert.equal(d.mods[2999].packageId, 'mod.n2999')
    await assert.rejects(store.get(dir, '../secret.rws'), /bad save name/)
    await assert.rejects(store.get(dir, '..\\secret'), /bad save name/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
