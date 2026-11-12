import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseVdf, parseChangelog, normalizeGitUrl, repoName, createBackupStore, readWorkshopState } from '../src/host/modversions.js'

const ACF = `"AppWorkshop"
{
	"appid"		"294100"
	"WorkshopItemsInstalled"
	{
		"111"
		{
			"size"		"10"
			"timeupdated"		"1000"
		}
	}
	"WorkshopItemDetails"
	{
		"111"
		{
			"timeupdated"		"1000"
			"latest_timeupdated"		"2000"
		}
	}
}`

test('parseVdf + readWorkshopState detect pending updates', async () => {
  assert.equal(parseVdf(ACF).AppWorkshop.WorkshopItemsInstalled['111'].timeupdated, '1000')
  const root = await mkdtemp(path.join(tmpdir(), 'rl-acf-'))
  const ws = path.join(root, 'steamapps', 'workshop', 'content', '294100')
  await mkdir(ws, { recursive: true })
  await writeFile(path.join(root, 'steamapps', 'workshop', 'appworkshop_294100.acf'), ACF)
  const st = await readWorkshopState(ws)
  assert.deepEqual({ ...st.items.get('111') }, { installed: 1000, latest: 2000, size: 10, touched: 0, needsUpdate: true })
})

test('parseChangelog extracts entries newest first and flags auto text', () => {
  const html = `<p id="1700000000">[Auto-generated text]: Update on 1/1</p><p id="1710000000">Fixed <b>bug</b><br>Added &quot;x&quot;</p>`
  const e = parseChangelog(html)
  assert.equal(e[0].time, 1710000000)
  assert.equal(e[0].text, 'Fixed bug\nAdded "x"')
  assert.equal(e[1].auto, true)
})

test('normalizeGitUrl accepts github shorthand and rejects option injection / local paths', () => {
  assert.equal(normalizeGitUrl('pardeike/HarmonyRimWorld'), 'https://github.com/pardeike/HarmonyRimWorld')
  assert.equal(normalizeGitUrl('https://github.com/a/b/tree/main/x'), 'https://github.com/a/b')
  assert.throws(() => normalizeGitUrl('--upload-pack=touch /tmp/x'))
  assert.throws(() => normalizeGitUrl('/etc'))
  assert.throws(() => normalizeGitUrl('file:///etc'))
  assert.equal(repoName('git@github.com:a/My.Mod.git'), 'My.Mod')
})

test('backup store: snapshot once per version, prune, restore into Mods/', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rl-bk-'))
  const src = path.join(root, 'ws', '123')
  await mkdir(path.join(src, 'About'), { recursive: true })
  await writeFile(path.join(src, 'About', 'About.xml'), '<ModMetaData><packageId>a.b</packageId></ModMetaData>')
  const store = createBackupStore({ dataDir: path.join(root, 'data') })
  const mod = { key: 'a.b', packageId: 'a.b', name: 'AB', source: 'workshop', folder: '123', path: src, mtime: 0 }
  const b1 = await store.backup(mod, { version: '100', keep: 2 })
  assert.equal(b1.size > 0, true)
  assert.equal((await store.backup(mod, { version: '100', keep: 2 })).skipped, true)
  await store.backup(mod, { version: '200', keep: 2 })
  await store.backup(mod, { version: '300', keep: 2 })
  const list = await store.list('a.b')
  assert.deepEqual(list.map((x) => x.version).sort(), ['200', '300'])
  const mods = path.join(root, 'Mods')
  const r = await store.restore(list.find((x) => x.version === '200').id, mods)
  assert.equal(r.folder, '123_rimlist_200')
  assert.match(await readFile(path.join(mods, r.folder, 'About', 'About.xml'), 'utf8'), /a\.b/)
  assert.ok((await readdir(path.join(mods, r.folder))).includes('.rimlist-restored.json'))
  await assert.rejects(store.restore('../x/y', mods))
})
