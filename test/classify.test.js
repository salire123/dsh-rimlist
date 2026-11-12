import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyMod, finalize, sentencesOf, topLevelDefs } from '../src/host/classify.js'

const facts = (patch = {}) => ({
  defs: {}, defFiles: 0, abstractDefs: 0,
  thingHints: { apparel: 0, weapon: 0, building: 0, furniture: 0, item: 0, food: 0, drug: 0, animal: 0, plant: 0, mech: 0 },
  patchFiles: 0, patchOps: 0, findModTargets: new Set(), mayRequire: new Set(), conditionalFolders: new Set(),
  langFiles: 0, defInjected: 0, keyed: 0, languages: new Set(), textures: 0, sounds: 0,
  dlls: [], dllHits: {}, dllExamples: {}, patched: new Set(), loadFolders: false, otherFiles: 0,
  ...patch,
})
const mod = (patch = {}) => ({ key: 'a.b', packageId: 'a.b', name: 'Mod', author: 'A', supportedVersions: ['1.6'], description: '', modDependencies: [], ...patch })

test('description becomes short quotable evidence', () => {
  assert.deepEqual(sentencesOf('[h1]Title[/h1]\\nAdds a new storage menu. https://x.y\\nSecond line!'), ['Adds a new storage menu.', 'Second line!'])
  assert.deepEqual(topLevelDefs('<Defs><ThingDef><x/></ThingDef><!-- no --><FactionDef Abstract="true"></FactionDef></Defs>').map((d) => d.tag), ['ThingDef', 'FactionDef'])
})

test('translation-only mod', () => {
  const r = classifyMod(mod({ name: 'Allow Tool zh-pack', description: '简体中文汉化。' }), facts({ langFiles: 18, languages: new Set(['ChineseSimplified (简体中文)']) }))
  assert.equal(r.primary_type, 'translation')
  assert.equal(r.is_translation, true)
  assert.ok(r.feature_tags.includes('translation_zh'))
  assert.ok(r.confidence > 0.8)
})

test('compatibility xml patch', () => {
  const r = classifyMod(mod({ name: 'Ratkin Gene Patch' }), facts({ patchOps: 12, mayRequire: new Set(['solaris.ratkinracemod']) }))
  assert.equal(r.primary_type, 'patch')
  assert.equal(r.is_patch, true)
  assert.ok(r.feature_tags.includes('compatibility'))
  assert.ok(r.evidence.some((e) => e.includes('solaris.ratkinracemod')))
})

test('new defs are content; code-only ui patch is ui', () => {
  const content = classifyMod(mod({ name: 'Ratkin Race', description: 'Adds a new race and faction.' }), facts({ defs: { ThingDef: 30, FactionDef: 2, 'AlienRace.ThingDef_AlienRace': 1 }, textures: 200 }))
  assert.equal(content.primary_type, 'content')
  assert.ok(content.feature_tags.includes('race'))
  const ui = classifyMod(mod({ name: 'Better Menus', description: 'Improves menu buttons and icons. You can toggle it in mod settings.' }), facts({ dlls: ['Menus.dll'], dllHits: { menu: 2, button: 4, icon: 4, settings: 1, toggle: 1 }, dllExamples: { settings: ['ModSettings'] }, patched: new Set(['FloatMenu.DoWindowContents']) }))
  assert.equal(ui.primary_type, 'ui')
  assert.equal(ui.is_content_mod, false)
  assert.ok(ui.secondary_types.includes('qol'))
})

test('ai result is normalized', () => {
  const r = finalize({ primary_type: 'library', secondary_types: ['library', 'patch', 'bad'], feature_tags: ['api'], confidence: 2, evidence: ['Framework for modders.'], source: 'ai' })
  assert.deepEqual(r.secondary_types, ['patch'])
  assert.equal(r.is_library, true)
  assert.equal(r.is_patch, true)
  assert.equal(r.confidence, 1)
})
