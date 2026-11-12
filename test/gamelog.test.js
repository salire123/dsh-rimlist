import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLog, summarize, summaryToText, levelOf, attributeMods } from '../src/host/gamelog.js'

const LOG = `Mono path[0] = '/x'
RimWorld 1.6.4871 rev598
[Star Wars - Fully Functional Lightsabers (Continued)] Config error in PJ_KyberCrystal: label contains illegal character(s): "[]{}".
[Star Wars - Fully Functional Lightsabers (Continued)] Config error in PJ_KyberCrystalBlue: label contains illegal character(s): "[]{}".
(Filename: C:\\buildslave\\unity\\Runtime/Export/Debug.bindings.h Line: 39)

Exception in Verse.StaticConstructorOnStartupUtility: System.NullReferenceException: Object reference not set
  at Foo.Bar.Baz () [0x00000] in <abc>:0
  at Verse.LongEventHandler.Run () [0x00001] in <abc>:0
[Humanoid Alien Races] Alien race successfully completed 286 patches with harmony.
Key binding conflict: A and B are both bound to I.
`
const mods = [
  { key: 'mlie.sw', packageId: 'mlie.sw', name: 'Star Wars - Fully Functional Lightsabers (Continued)', kind: 'mod' },
  { key: 'foo.mod', packageId: 'foo.mod', name: 'Foo', kind: 'mod' },
]

test('parseLog groups stack traces and collapses repeated patterns', () => {
  const { entries, counts } = parseLog(LOG)
  const exc = entries.find((e) => e.line.startsWith('Exception'))
  assert.equal(exc.level, 'error')
  assert.equal(exc.trace.length, 2)
  const sw = entries.filter((e) => e.line.includes('KyberCrystal'))
  assert.equal(counts.get(sw[0].pattern), 2)
  assert.equal(levelOf('[Humanoid Alien Races] Alien race successfully completed 286 patches'), 'info')
  assert.equal(levelOf('Key binding conflict: A and B'), 'warning')
})

test('summary is de-duplicated and attributes mods by [Name] prefix', () => {
  const sum = summarize({ text: LOG, mods })
  const sw = sum.entries.find((e) => e.line.includes('KyberCrystal'))
  assert.equal(sw.count, 2)
  assert.deepEqual(sw.mods, ['mlie.sw'])
  assert.equal(sum.entries.filter((e) => e.line.includes('KyberCrystal')).length, 1)
  const txt = summaryToText(sum, (k) => k, 'Player.log')
  assert.match(txt, /×2/)
  assert.match(txt, /Mods mentioned in errors: mlie\.sw/)
  assert.ok(!/Filename:/.test(txt))
  assert.deepEqual(attributeMods({ line: 'in Foo.Bar', trace: [] }, mods), [])
})

test('parseLog reads the RimWorld 1.7 structured format', () => {
  const log = [
    '=== RimWorld by Ludeon Studios log ===',
    'Started:   2026-10-14 18:33:00.575 +08:00',
    '',
    '2026-10-14 18:33:00.510  INFO [GraphicsDevice] GPU ok',
    '    at Brutal.Logging.LogCategory.Info(LogString`1 message) [0x0]',
    '2026-10-14 18:33:01.323  WARN [Verse] Mod X dependency (a.b) needs <downloadUrl>',
    '    at Verse.Log.Warning(String text) [0x19]',
    '    at Verse.ModMetaData.Init() [0x116]',
    '2026-10-14 18:31:22.089 ERROR [Verse] Error while instantiating a mod of type Foo.FooMod',
    ' ---> HarmonyLib.HarmonyException: Patching exception',
    '   at HarmonyLib.PatchClassProcessor.Patch()',
  ].join('\n')
  const { entries } = parseLog(log)
  const lv = entries.map((e) => e.level)
  assert.deepEqual(lv.filter((l) => l !== 'info'), ['warning', 'error'])
  const w = entries.find((e) => e.level === 'warning')
  assert.equal(w.line, 'Mod X dependency (a.b) needs <downloadUrl>')
  assert.deepEqual(w.trace, ['    at Verse.ModMetaData.Init() [0x116]'])
  const e = entries.find((x) => x.level === 'error')
  assert.equal(e.trace.length, 2)
  assert.equal(entries.find((x) => x.line.includes('GPU')).line, '[GraphicsDevice] GPU ok')
})
