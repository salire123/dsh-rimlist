// Quick manual check: scan the local RimWorld install and print a summary.
import { discoverPaths, readGameVersion } from '../src/host/paths.js'
import { scanMods } from '../src/host/scan.js'

const paths = await discoverPaths()
const ver = await readGameVersion(paths.gameDir)
console.log(paths, ver)
const t = Date.now()
const { mods, duplicates } = await scanMods({ ...paths, major: ver?.major })
console.log('mods:', mods.length, 'in', Date.now() - t, 'ms', 'duplicates:', duplicates.length)
const bySource = {}
for (const m of mods) bySource[m.source] = (bySource[m.source] || 0) + 1
console.log(bySource)
console.log(mods.filter((m) => m.invalid).map((m) => [m.folder, m.invalid]))
console.log(mods.slice(0, 8).map((m) => [m.key, m.name, m.kind, m.supportedVersions.join('/'), m.loadAfter.length, m.modDependencies.length]))
const notSupported = mods.filter((m) => m.kind === 'mod' && !m.supportedVersions.includes(ver?.major))
console.log('not supporting', ver?.major, ':', notSupported.length, notSupported.slice(0, 5).map((m) => m.name))
