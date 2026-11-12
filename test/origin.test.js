import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createListStore, cleanGit } from '../src/host/lists.js'

test('cleanGit keeps only shareable remote urls', () => {
  assert.equal(cleanGit({ url: '/home/me/repo' }), undefined)
  assert.deepEqual(cleanGit({ url: 'https://user:tok@github.com/a/b.git', branch: 'main' }), { url: 'https://github.com/a/b.git', branch: 'main' })
  assert.deepEqual(cleanGit({ url: 'git@github.com:a/b.git', branch: 'HEAD' }), { url: 'git@github.com:a/b.git' })
})

test('lists remember where mods come from and round-trip via rimlist + markdown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rl-origin-'))
  try {
    const s = createListStore({ dataDir: dir })
    const l = await s.save({ name: 'x', mods: [
      { packageId: 'a.git', name: 'A', source: 'git', git: { url: 'https://github.com/o/a', branch: 'dev' } },
      { packageId: 'b.ws', name: 'B', publishedFileId: '123456789', source: 'workshop' },
    ] })
    assert.deepEqual((await s.get(l.id)).mods[0].git, { url: 'https://github.com/o/a', branch: 'dev' })
    const fromJson = s.parseText(s.toText(l, 'rimlist'))
    assert.equal(fromJson.mods[0].source, 'git')
    assert.equal(fromJson.mods[0].git.url, 'https://github.com/o/a')
    const fromMd = s.parseText(s.toText(l, 'markdown'))
    assert.deepEqual(fromMd.mods[0].git, { url: 'https://github.com/o/a', branch: 'dev' })
    assert.equal(fromMd.mods[1].publishedFileId, '123456789')
    const r = s.resolveMods(fromJson.mods, new Map(), null)
    assert.equal(r[0].installed, false)
    assert.equal(r[0].git.url, 'https://github.com/o/a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tag store: clearAllAi removes overrides', async () => {
  const { createTagStore } = await import('../src/host/classify.js')
  const mem = {}
  const st = createTagStore({ dataDir: '/x', readJson: async (p) => { if (!mem[p]) throw new Error('no'); return mem[p] }, writeJson: async (p, v) => { mem[p] = JSON.parse(JSON.stringify(v)) } })
  await st.setAi('a', { source: 'user' })
  await st.setAi('b', { source: 'ai' })
  await st.setAi('c', { source: 'ai' })
  assert.equal(await st.clearAllAi(['b', 'zz']), 1)
  assert.equal(await st.clearAllAi(), 2)
  assert.deepEqual((await st.all()).ai, {})
})
