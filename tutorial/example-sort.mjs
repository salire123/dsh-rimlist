// 演示：用假的 mod 数据跑一遍真实的排序算法，看看规则是怎么生效的。
// 运行：node tutorial/example-sort.mjs   （在仓库根目录执行）

import { sortLoadOrder, diagnose } from '../src/host/sorter.js'

// 造一个 mod 对象。真实项目里这来自 src/host/scan.js
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

// 假的规则库：只实现 sortLoadOrder 真正用到的几个方法
const fakeRules = (rules = {}) => ({
  rulesFor: (k) => ({ loadAfter: {}, loadBefore: {}, incompatibleWith: {}, loadTop: null, loadBottom: null, ...(rules[k] || {}) }),
  steamByPid: () => undefined,
  steamByPfid: () => undefined,
  nvwCovers: () => false,
  ignoresIncompatible: () => false,
  replacementFor: () => undefined,
})

const catalog = new Map(
  [
    mod('ludeon.rimworld', { name: 'Core' }),
    mod('brrainz.harmony', { name: 'Harmony', loadBefore: ['ludeon.rimworld'] }),
    mod('vanilla.expanded.core', { name: 'Vanilla Expanded Framework', modDependencies: [{ packageId: 'brrainz.harmony', displayName: 'Harmony' }] }),
    mod('ratkin.race', { name: 'Ratkin Race', modDependencies: [{ packageId: 'vanilla.expanded.core', displayName: 'VEF' }] }),
    mod('ratkin.gene.patch', { name: 'Ratkin Gene Patch', loadAfter: ['ratkin.race'] }),
    mod('rocketman', { name: 'RocketMan' }),
    mod('some.qol', { name: 'Some QoL Tweaks' }),
  ].map((m) => [m.key, m]),
)

// 社区规则：RocketMan 要最后加载
const rules = fakeRules({
  rocketman: { loadBottom: { comment: '性能补丁，必须最后' } },
})

// 故意打乱当前顺序
const current = ['some.qol', 'ratkin.gene.patch', 'vanilla.expanded.core', 'ludeon.rimworld', 'rocketman', 'brrainz.harmony', 'ratkin.race']

console.log('当前顺序（乱）:')
current.forEach((k, i) => console.log(`  ${i + 1}. ${catalog.get(k).name}`))

const before = diagnose(current, catalog, rules, { gameMajor: '1.6' })
console.log(`\n排序前诊断: ${before.counts.error} errors, ${before.counts.warning} warnings, ${before.counts.info} info`)
for (const i of before.issues) console.log(`  ${i.level.padEnd(7)} [${i.code}] ${i.modName}: ${i.message}`)

const r = sortLoadOrder(current, catalog, rules)
console.log(`\n排序后（移动了 ${r.moved} 个，破环 ${r.broken.length} 个）:`)
r.order.forEach((k, i) => console.log(`  ${i + 1}. ${catalog.get(k).name}`))

const after = diagnose(r.order, catalog, rules, { gameMajor: '1.6' })
console.log(`\n排序后诊断: ${after.counts.error} errors, ${after.counts.warning} warnings, ${after.counts.info} info`)

const again = sortLoadOrder(r.order, catalog, rules)
console.log(`\n再排一次，移动 ${again.moved} 个 → 幂等性: ${again.moved === 0 ? '通过 ✓' : '失败 ✗'}`)
