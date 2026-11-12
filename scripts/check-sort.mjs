// Manual check: scan, load rules (seeded from .ref if present), diagnose + sort the live ModsConfig.
import { readFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { discoverPaths, readGameVersion, exists } from '../src/host/paths.js'
import { scanMods } from '../src/host/scan.js'
import { parseModsConfig, pid } from '../src/host/xml.js'
import { createRuleStore } from '../src/host/rules.js'
import { sortLoadOrder, diagnose } from '../src/host/sorter.js'

const dataDir = path.resolve('.tmp-data')
await mkdir(path.join(dataDir, 'db'), { recursive: true })
// Seed from local clones to avoid downloading during development.
if (await exists('.ref/Community-Rules-Database/communityRules.json') && !(await exists(path.join(dataDir, 'db/communityRules.json')))) {
  await copyFile('.ref/Community-Rules-Database/communityRules.json', path.join(dataDir, 'db/communityRules.json'))
}
const paths = await discoverPaths()
const ver = await readGameVersion(paths.gameDir)
const t0 = Date.now()
const { mods, byId, duplicates } = await scanMods({ ...paths, major: ver?.major })
console.log('scan', mods.length, Date.now() - t0, 'ms')

const store = createRuleStore({ dataDir, log: console.log })
// Build slim steam DB from the local clone if there is no cache yet.
if (await exists('.ref/Steam-Workshop-Database/steamDB.json') && !(await exists(path.join(dataDir, 'db/steamDB.slim.json')))) {
  const raw = JSON.parse(await readFile('.ref/Steam-Workshop-Database/steamDB.json', 'utf8'))
  const fakeFetch = async () => ({ ok: true, text: async () => JSON.stringify(raw) })
  const s2 = createRuleStore({ dataDir, fetchImpl: fakeFetch })
  const t = Date.now()
  await s2.refreshSteam()
  console.log('steam slim built in', Date.now() - t, 'ms')
}
if (await exists('.ref/NoVersionWarning/1.6/ModIdsToFix.xml') && !(await exists(path.join(dataDir, 'db/noVersionWarning-1.6.json')))) {
  const xml = await readFile('.ref/NoVersionWarning/1.6/ModIdsToFix.xml', 'utf8')
  const s3 = createRuleStore({ dataDir, fetchImpl: async () => ({ ok: true, text: async () => xml }) })
  await s3.refreshNvw('1.6')
}
const t1 = Date.now()
await store.ensure({ major: ver?.major, maxAgeHours: 1e9 })
console.log('rules loaded in', Date.now() - t1, 'ms', JSON.stringify(await store.status(), null, 1))

const cfg = parseModsConfig(await readFile(path.join(paths.configDir, 'ModsConfig.xml'), 'utf8'))
const active = cfg.activeMods.map(pid)
console.log('active', active.length)

const t2 = Date.now()
const diag = diagnose(active, byId, store, { gameMajor: ver?.major, duplicates })
console.log('diagnose', Date.now() - t2, 'ms', diag.counts)
for (const i of diag.issues.slice(0, 25)) console.log(' ', i.level.padEnd(7), i.code.padEnd(20), (i.modName || '').slice(0, 30).padEnd(31), i.message.slice(0, 110))

const t3 = Date.now()
const sorted = sortLoadOrder(active, byId, store)
console.log('sort', Date.now() - t3, 'ms', 'moved', sorted.moved, 'broken cycles', sorted.broken.length, 'crossTier', sorted.crossTierViolations.length)
for (const b of sorted.broken) console.log('  cycle:', b.cycle.join(' ; '), '| dropped', b.dropped.source, b.dropped.from, '>', b.dropped.to)
console.log(sorted.order.map((k, i) => `${String(i + 1).padStart(2)} ${(byId.get(k)?.name || k).slice(0, 40)}`).join('\n'))
const diag2 = diagnose(sorted.order, byId, store, { gameMajor: ver?.major, duplicates })
console.log('after sort', diag2.counts)
const again = sortLoadOrder(sorted.order, byId, store)
console.log('idempotent:', again.moved === 0)
console.log('--- cross-tier violations')
for (const e of sorted.crossTierViolations) console.log(' ', e.source, byId.get(e.from)?.name, '>', byId.get(e.to)?.name, '| tiers', e.from, e.to)
for (const i of diag2.issues) console.log(' ', i.level, i.code, i.modName, '|', i.message)
