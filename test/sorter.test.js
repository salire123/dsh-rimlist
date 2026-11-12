import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortLoadOrder, diagnose } from '../src/host/sorter.js'

const mod = (key, extra = {}) => ({
  key,
  packageId: key,
  name: key,
  kind: key === 'ludeon.rimworld' ? 'core' : key.startsWith('ludeon.rimworld.') ? 'expansion' : 'mod',
  source: 'workshop',
  supportedVersions: ['1.6'],
  loadFolderVersions: [],
  loadAfter: [],
  loadBefore: [],
  forceLoadAfter: [],
  forceLoadBefore: [],
  incompatibleWith: [],
  modDependencies: [],
  invalid: null,
  ...extra,
})
const catalogOf = (...mods) => new Map(mods.map((m) => [m.key, m]))
const fakeRules = (rules = {}) => ({
  rulesFor: (k) => ({ loadAfter: {}, loadBefore: {}, incompatibleWith: {}, loadTop: null, loadBottom: null, ...(rules[k] || {}) }),
  steamByPid: () => undefined,
  steamByPfid: () => undefined,
  nvwCovers: () => false,
})

test('core first, expansions in canonical order, harmony promoted before core', () => {
  const cat = catalogOf(
    mod('ludeon.rimworld'),
    mod('ludeon.rimworld.biotech'),
    mod('ludeon.rimworld.royalty'),
    mod('brrainz.harmony', { loadBefore: ['ludeon.rimworld'] }),
    mod('some.mod'),
  )
  const r = sortLoadOrder(['some.mod', 'ludeon.rimworld.biotech', 'ludeon.rimworld', 'brrainz.harmony', 'ludeon.rimworld.royalty'], cat, fakeRules())
  assert.deepEqual(r.order, ['brrainz.harmony', 'ludeon.rimworld', 'ludeon.rimworld.royalty', 'ludeon.rimworld.biotech', 'some.mod'])
  assert.equal(r.broken.length, 0)
})

test('dependencies, about rules and community rules create edges; loadBottom goes last', () => {
  const cat = catalogOf(
    mod('ludeon.rimworld'),
    mod('a', { modDependencies: [{ packageId: 'b', displayName: 'B' }] }),
    mod('b'),
    mod('c', { loadAfter: ['a'] }),
    mod('rocket'),
    mod('d'),
  )
  const rules = fakeRules({ rocket: { loadBottom: { source: 'community' } }, d: { loadAfter: { c: { source: 'community' } } } })
  const r = sortLoadOrder(['rocket', 'd', 'c', 'a', 'b', 'ludeon.rimworld'], cat, rules)
  assert.equal(r.order[0], 'ludeon.rimworld')
  assert.ok(r.order.indexOf('b') < r.order.indexOf('a'))
  assert.ok(r.order.indexOf('a') < r.order.indexOf('c'))
  assert.ok(r.order.indexOf('c') < r.order.indexOf('d'))
  assert.equal(r.order.at(-1), 'rocket')
  // idempotent
  const again = sortLoadOrder(r.order, cat, rules)
  assert.equal(again.moved, 0)
})

test('tieBreak=current: unconstrained mods keep relative order', () => {
  const cat = catalogOf(mod('ludeon.rimworld'), mod('x'), mod('y'), mod('z'))
  const r = sortLoadOrder(['ludeon.rimworld', 'z', 'x', 'y'], cat, fakeRules(), { tieBreak: 'current' })
  assert.deepEqual(r.order, ['ludeon.rimworld', 'z', 'x', 'y'])
})

test('tieBreak=name (default): unconstrained mods alphabetical, constraints still win', () => {
  const cat = catalogOf(mod('ludeon.rimworld'), mod('a1', { name: 'Zeta' }), mod('b1', { name: 'alpha' }), mod('c1', { name: 'Beta', loadAfter: ['a1'] }), mod('d1', { name: 'Mod 10' }), mod('e1', { name: 'Mod 9' }))
  const r = sortLoadOrder(['ludeon.rimworld', 'a1', 'c1', 'd1', 'e1', 'b1'], cat, fakeRules())
  // Beta must wait for Zeta (loadAfter); Mod 9 < Mod 10 (numeric); case-insensitive
  assert.deepEqual(r.order, ['ludeon.rimworld', 'b1', 'e1', 'd1', 'a1', 'c1'])
  assert.deepEqual(sortLoadOrder(r.order, cat, fakeRules()).order, r.order)
})

test('cycles are broken by dropping the weakest edge and reported', () => {
  const cat = catalogOf(mod('ludeon.rimworld'), mod('a', { loadAfter: ['b'] }), mod('b'))
  const rules = fakeRules({ b: { loadAfter: { a: { source: 'community' } } } }) // community says b after a; about says a after b
  const r = sortLoadOrder(['ludeon.rimworld', 'a', 'b'], cat, rules)
  assert.equal(r.broken.length, 1)
  assert.equal(r.broken[0].dropped.source, 'community')
  assert.ok(r.order.indexOf('b') < r.order.indexOf('a'))
})

test('community rules beat modDependencies', () => {
  const cat = catalogOf(mod('ludeon.rimworld'), mod('a', { modDependencies: [{ packageId: 'b' }] }), mod('b'))
  const rules = fakeRules({ b: { loadAfter: { a: { source: 'community' } } } }) // dependency: b before a; community: b after a
  const r = sortLoadOrder(['ludeon.rimworld', 'a', 'b'], cat, rules)
  assert.equal(r.broken[0].dropped.source, 'dependency')
  assert.ok(r.order.indexOf('a') < r.order.indexOf('b'))
})

test('user rules beat community rules', () => {
  const cat = catalogOf(mod('ludeon.rimworld'), mod('a'), mod('b'))
  const rules = fakeRules({ a: { loadAfter: { b: { source: 'community' } } }, b: { loadAfter: { a: { source: 'user' } } } })
  const r = sortLoadOrder(['ludeon.rimworld', 'a', 'b'], cat, rules)
  assert.ok(r.order.indexOf('a') < r.order.indexOf('b'))
  assert.equal(r.broken[0].dropped.source, 'community')
})

test('diagnose reports missing deps, versions, incompatibilities, order violations', () => {
  const cat = catalogOf(
    mod('ludeon.rimworld'),
    mod('a', { modDependencies: [{ packageId: 'dep', displayName: 'Dep', steamWorkshopUrl: 'steam://url/CommunityFilePage/123456' }], supportedVersions: ['1.4'] }),
    mod('b', { loadAfter: ['c'], incompatibleWith: ['a'] }),
    mod('c'),
    mod('inst'),
    mod('needsinst', { modDependencies: [{ packageId: 'inst', displayName: 'Inst' }] }),
  )
  const d = diagnose(['ludeon.rimworld', 'a', 'b', 'c', 'needsinst'], cat, fakeRules(), { gameMajor: '1.6' })
  const codes = d.issues.map((i) => i.code)
  assert.ok(codes.includes('dependency-missing'))
  assert.ok(codes.includes('dependency-inactive'))
  assert.ok(codes.includes('version-mismatch'))
  assert.ok(codes.includes('incompatible'))
  assert.ok(codes.includes('order-about'))
  const missing = d.issues.find((i) => i.code === 'dependency-missing')
  assert.equal(missing.steam.pfid, '123456')
  const inactive = d.issues.find((i) => i.code === 'dependency-inactive')
  assert.equal(inactive.fix, 'activate')
  assert.equal(inactive.target, 'inst')
  const d2 = diagnose(['a'], cat, fakeRules(), { gameMajor: '1.6' })
  assert.ok(d2.issues.some((i) => i.code === 'missing-core'))
  const d3 = diagnose(['ludeon.rimworld', 'ghost.mod'], cat, fakeRules(), {})
  assert.ok(d3.issues.some((i) => i.code === 'missing-mod'))
})

test('diagnose: use-this-instead offers "replace" when the replacement is already downloaded', () => {
  const rep = { newPfid: '222', newName: 'Old (Continued)', newPackageId: 'new.mod' }
  const rules = { ...fakeRules(), replacementFor: ({ publishedFileId }) => (publishedFileId === '111' ? rep : undefined) }
  // not downloaded → subscribe
  const cat1 = catalogOf(mod('ludeon.rimworld'), mod('old.mod', { publishedFileId: '111' }))
  const i1 = diagnose(['ludeon.rimworld', 'old.mod'], cat1, rules).issues.find((i) => i.code === 'use-this-instead')
  assert.equal(i1.fix, 'subscribe')
  assert.equal(i1.installedKey, undefined)
  // downloaded (matched by workshop id even with an unexpected packageId) → replace
  const cat2 = catalogOf(mod('ludeon.rimworld'), mod('old.mod', { publishedFileId: '111' }), mod('other.id', { publishedFileId: '222' }))
  const i2 = diagnose(['ludeon.rimworld', 'old.mod'], cat2, rules).issues.find((i) => i.code === 'use-this-instead')
  assert.equal(i2.fix, 'replace')
  assert.equal(i2.installedKey, 'other.id')
  // replacement already active → no suggestion
  assert.ok(!diagnose(['ludeon.rimworld', 'old.mod', 'other.id'], cat2, rules).issues.some((i) => i.code === 'use-this-instead'))
})

test('tieBreak=rimsort: level-by-level, alphabetical within a level (RimSort Topological)', () => {
  // c depends on a; b, d unconstrained. Greedy-name gives a,b,c,d; RimSort gives level0 [a,b,d] then level1 [c].
  const cat = catalogOf(mod('ludeon.rimworld'), mod('a'), mod('b'), mod('c', { loadAfter: ['a'] }), mod('d'))
  const r = sortLoadOrder(['ludeon.rimworld', 'd', 'c', 'b', 'a'], cat, fakeRules(), { tieBreak: 'rimsort' })
  assert.deepEqual(r.order, ['ludeon.rimworld', 'a', 'b', 'd', 'c'])
  assert.deepEqual(sortLoadOrder(['ludeon.rimworld', 'a', 'b', 'c', 'd'], cat, fakeRules()).order, ['ludeon.rimworld', 'a', 'b', 'c', 'd'])
})
