/**
 * Mod type classifier.
 *
 * Gives every mod a primary_type + secondary_types + feature_tags, each backed by
 * evidence: short sentences quoted from About.xml plus facts read from the mod
 * folder (Def types, patch operations, language files, identifiers in the DLLs).
 *
 * The AI can read this, then store a corrected verdict (source: 'ai') that wins
 * over the automatic one.
 *
 * Rules (from the spec):
 *  1. Never a single label: primary_type + secondary_types + feature_tags.
 *  2. Exactly one primary_type, chosen by the mod's main purpose.
 *  3. Only caches / sorting / measuring / rendering / menus / buttons / icons, no new Defs
 *     -> performance or ui.
 *  4. Menus, buttons, icons, text measuring or pagination -> add ui.
 *  5. Toggles / optional features -> add qol or utility.
 *  6. New buildings, items, races, factions, events, maps or gameplay -> content.
 *  7. Prerequisite / API / framework -> library.
 *  8. Changes compatibility with other mods -> patch.
 *  9. A translation -> translation.
 * 10. Output always has confidence and evidence.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export const TYPES = ['content', 'library', 'patch', 'translation', 'performance', 'ui', 'qol', 'utility']
export const FEATURE_TAGS = []
export const TYPE_ZH = {
  content: '内容',
  library: '前置/框架',
  patch: '补丁/兼容',
  translation: '翻译',
  performance: '性能',
  ui: '界面',
  qol: '生活改善',
  utility: '工具',
}
export const TAG_ZH = {
  race: '种族', faction: '派系', building: '建筑', furniture: '家具', weapon: '武器', apparel: '服装', item: '物品',
  food: '食物', drug: '药物', animal: '动物', plant: '植物', event: '事件', quest: '任务', storyteller: '叙事者',
  scenario: '剧本', map: '地图生成', biome: '生物群系', terrain: '地形', gene: '基因', xenotype: '异种', ability: '技能/能力',
  psycast: '灵能', research: '研究', recipe: '配方', trait: '特性', hediff: '健康状态', ideology: '文化/模因',
  mech: '机械体', vehicle: '载具', music: '音乐', sound: '音效', texture: '贴图', retexture: '换贴图', animation: '动画',
  harmony: 'Harmony 代码', xml_only: '纯 XML', cache: '缓存', render: '渲染', text_measure: '文本测量', sorting: '排序',
  menu: '菜单', button: '按钮', icon: '图标', tab: '面板/标签页', tooltip: '提示', pagination: '分页', window: '窗口',
  settings: '可设置', toggle: '可开关', keybind: '快捷键', compatibility: '兼容', api: 'API', framework: '框架',
  translation_zh: '中文', translation_other: '其他语言', camera: '镜头', save: '存档', debug: '调试', automation: '自动化',
  storage: '存储', joblogic: '工作/AI 逻辑', medical: '医疗', loading: '加载速度', optimization: '优化',
}

/* ------------------------------------------------------------------ keyword tables */
// Each entry: [type, regex for the mod name, regex for description sentences]
FEATURE_TAGS.push(...Object.keys(TAG_ZH))
const KW = {
  translation: {
    name: /(\bzh\b|[-_ ]zh$|\bzh[-_ ]|chinese|中文|汉化|漢化|简体|繁體|繁简|簡繁|简繁|translation|翻译|翻譯|language pack|\bjp\b|日本語|русск|korean|한국어|deutsch|français|español|português|polski|türkçe)/i,
    desc: /(translat|汉化|漢化|翻译|翻譯|中文|简体|繁體|localiz|language pack|语言包|語言包)/i,
  },
  library: {
    name: /(framework|librar|\blib\b|lib$|\bapi\b|前置|框架|核心库|\bcore\b|toolkit|\butils?\b)/i,
    desc: /(\bframework\b|\ba (?:shared )?library\b|library (?:for|mod|that)|\bAPI\b|for (?:other )?modders|other mods (?:use|need|require)|required by (?:other|many|several)|dependency for|is a dependency|modders can|前置|框架|依赖库|供其他)/,
  },
  patch: {
    name: /(patch|compat|兼容|补丁|補丁|适配|適配|\bfix\b|fixes|addon\b|add-on)/i,
    desc: /(compatibility (?:patch|fix|layer|addon|add-on)|\bpatch(?:es)? (?:for|to make|that makes)\b|adds? compatibility|makes? .{0,40} compatible|integration with|\bfix(?:es)? (?:for|a bug|the bug|an? (?:issue|error))|兼容(?:补丁|性补丁|patch)|补丁|補丁|适配|適配|修复)/i,
  },
  performance: {
    name: /(performance|optimi[sz]|\bfps\b|\btps\b|\blag\b|faster|speed ?up|\bcache|loading|性能|优化|優化|加速|多核|帧|卡顿|\bgc\b)/i,
    desc: /(performance|optimi[sz]|\bfps\b|\btps\b|\blag\b|faster|loading time|load time|\bcach(?:e|es|ing)\b|memory|garbage|ticks? (?:less|rare)|性能|优化|優化|加速|卡顿|缓存|帧率|读档)/i,
  },
  ui: {
    name: /(\bui\b|menu|\btab\b|\bhud\b|interface|icon|tooltip|button|inspect|overlay|minimap|display|菜单|界面|按钮|图标|显示|面板)/i,
    desc: /(\bui\b|user interface|\bmenus?\b|\bbuttons?\b|\bicons?\b|\btabs?\b|tooltip|\bhud\b|overlay|window|gizmo|readout|\bdisplay(?:s|ed)?\b|菜单|界面|按钮|图标|显示|面板|提示框)/i,
  },
  qol: {
    name: /(quality of life|\bqol\b|smart|auto|convenien|better|improved|便利|自动|智能|改进)/i,
    desc: /(quality of life|\bqol\b|convenien|tedious|micromanag|automatic(?:ally)?|\bauto[- ]?\w+|you can (?:now )?toggle|can be (?:toggled|disabled|enabled|turned off)|optional|mod settings|configurable|便利|自动|可选|开关|设置中|可以关闭)/i,
  },
  utility: {
    name: /(tool|editor|\bdev\b|debug|\blog\b|save|camera|cam\b|manager|工具|编辑|存档|日志|镜头)/i,
    desc: /(\btool\b|editor|dev ?mode|debug|\blogs?\b|save ?files?|camera|screenshot|export|工具|编辑器|存档|日志|截图|调试)/i,
  },
  content: {
    name: /(race|faction|weapon|armou?r|apparel|furniture|building|expanded|expansion|event|quest|biome|种族|派系|武器|建筑|家具|服装|扩展|拓展|事件|任务)/i,
    desc: /(\badds?\b|\bnew (?:race|faction|weapon|building|furniture|item|apparel|event|quest|biome|animal|plant|gene|xenotype|map|storyteller|research)|\braces?\b|\bfactions?\b|\bweapons?\b|\bbuildings?\b|furniture|apparel|clothing|\bevents?\b|\bquests?\b|\bbiomes?\b|xenotype|新增|添加|加入了|种族|派系|武器|建筑|家具|服装|衣物|事件|任务|地图|基因|异种)/i,
  },
}
const FEATURE_KW = [
  ['camera', /camera|镜头/i], ['save', /save ?file|存档/i], ['debug', /debug|dev ?mode|调试/i], ['storage', /storage|stockpile|shel(f|ves)|存储|储存|仓库/i],
  ['automation', /automat|auto[- ]|自动/i], ['medical', /medic|surgery|医疗|手术/i], ['loading', /loading|load time|加载/i],
  ['animation', /animat|动画/i], ['retexture', /retextur|texture (?:replace|overhaul)|换贴图|重绘/i], ['music', /\bmusic|\bsongs?\b|音乐/i],
  ['joblogic', /\bjobs?\b|\bhaul|work ?giver|priorit|工作|搬运/i], ['keybind', /hotkey|keybind|key binding|快捷键/i],
]

// Top-level Def element -> feature tag. Content defs count toward rule 6.
const DEF_TAG = {
  'AlienRace.ThingDef_AlienRace': 'race', FactionDef: 'faction', PawnKindDef: 'faction', IncidentDef: 'event', GameConditionDef: 'event',
  QuestScriptDef: 'quest', StorytellerDef: 'storyteller', ScenarioDef: 'scenario', MapGeneratorDef: 'map', GenStepDef: 'map',
  BiomeDef: 'biome', TerrainDef: 'terrain', GeneDef: 'gene', XenotypeDef: 'xenotype', AbilityDef: 'ability', ResearchProjectDef: 'research',
  ResearchTabDef: 'research', RecipeDef: 'recipe', TraitDef: 'trait', HediffDef: 'hediff', PreceptDef: 'ideology', MemeDef: 'ideology',
  'Vehicles.VehicleDef': 'vehicle', SongDef: 'music', SoundDef: 'sound', MainButtonDef: 'menu', KeyBindingDef: 'keybind',
  ThoughtDef: 'trait', InteractionDef: 'event', RitualPatternDef: 'ideology', StyleCategoryDef: 'ideology',
}
const CONTENT_DEFS = new Set(['JobDef', 'WorkGiverDef', 'JoyGiverDef', 'ThinkTreeDef', 'DutyDef', 'StatDef', 
  'ThingDef', 'AlienRace.ThingDef_AlienRace', 'FactionDef', 'PawnKindDef', 'IncidentDef', 'GameConditionDef', 'QuestScriptDef', 'StorytellerDef',
  'ScenarioDef', 'MapGeneratorDef', 'GenStepDef', 'BiomeDef', 'TerrainDef', 'GeneDef', 'XenotypeDef', 'AbilityDef', 'ResearchProjectDef',
  'RecipeDef', 'TraitDef', 'HediffDef', 'PreceptDef', 'MemeDef', 'Vehicles.VehicleDef', 'ThoughtDef', 'RitualPatternDef', 'BodyDef',
  'LifeStageDef', 'WorldObjectDef', 'SitePartDef', 'ThingSetMakerDef', 'HairDef', 'BeardDef', 'TattooDef', 'BackstoryDef', 'AlienRace.BackstoryDef',
  'RulePackDef', 'JobDef', 'WorkGiverDef', 'ResearchTabDef', 'DamageDef', 'PsychicRitualDef', 'MentalStateDef', 'StyleCategoryDef',
])
// Defs that just configure UI / settings: no new gameplay (rule 3).
const UI_DEFS = new Set(['MainButtonDef', 'KeyBindingDef', 'KeyBindingCategoryDef', 'DesignationCategoryDef', 'DesignatorDropdownGroupDef', 'InspectTabDef', 'PawnTableDef', 'PawnColumnDef'])

// Identifier hints found in DLL metadata strings.
const DLL_SIGNALS = {
  harmony: /^(HarmonyPatch|HarmonyPrefix|HarmonyPostfix|HarmonyTranspiler|PatchAll)$/,
  cache: /Cache|Cached|Memoiz/,
  optimization: /Optimi[sz]|ObjectPool|Throttl|Profil|Perf(ormance)?(?![a-z])/,
  text_measure: /^(CalcSize|CalcHeight|CalcHeightCached|MeasureText|TextMeasure)$/,
  render: /^(Render\w*|Draw\w*Mesh\w*|DrawMeshNow|MeshPool|Graphics_\w+|PrintOnto|Printer_\w+|SectionLayer\w*)$/,
  menu: /FloatMenu|MainButton|MainTabWindow|Menu(?![a-z])/,
  button: /^(ButtonText|ButtonImage|ButtonInvisible|Gizmo\w*|Command_\w+|GetGizmos)$/,
  icon: /^(\w*Icon\w*)$/,
  tab: /^(ITab_\w+|TabRecord|FillTab|InspectTab\w*)$/,
  tooltip: /^(TooltipHandler|TipSignal|TooltipFor\w*)$/,
  pagination: /Paginat|PageIndex|CurrentPage|PageCount|NextPage|PrevPage/,
  window: /^(Window|Dialog_\w+|DoWindowContents)$/,
  settings: /^(ModSettings|GetSettings|DoSettingsWindowContents|SettingsCategory|ExposeData)$/,
  toggle: /^(CheckboxLabeled|Checkbox|ToggleableIcon|ToggleIcon|CheckboxMulti)$/,
  keybind: /^(KeyBindingDef|KeyPrefs|KeyDownEvent)$/,
  sorting: /^(Sort\w*|OrderBy\w*|Comparer\w*)$/,
}
// Vanilla classes a Harmony patch targets (from "<Class>_<Method>_Patch" type names and
// [HarmonyPatch(typeof(X), "M")] strings). Tells what the code really touches.
const PATCH_CLASS = {
  ui: /^(Widgets|Text|GenUI|GUI|Window|WindowStack|Dialog_\w+|MainTabWindow\w*|FloatMenu\w*|ITab\w*|Gizmo\w*|GizmoGridDrawer|Command\w*|InspectPane\w*|InspectTab\w*|TooltipHandler|MainMenuDrawer|GenMapUI|Designator\w*|ArchitectCategoryTab|MainButtonWorker\w*|MainButtonsRoot|PlaySettings|ColonistBar\w*|PawnColumnWorker\w*|PawnTable\w*|Listing\w*|Alert\w*|AlertsReadout|LetterStack|Messages|TimeControls|GlobalControls\w*|MouseoverReadout|ThingOverlays|PawnUIOverlay|ResourceReadout|WorldInspectPane|Page_\w*|HealthCardUtility|CharacterCardUtility|InfoCardUtility|StatsReportUtility|BillStack|Bill\w*|ThingFilterUI|TradeUI|Tradeable\w*|CameraDriver|SelectionDrawer|Selector|DragBox|Root_Play|UIRoot\w*|MapInterface|CompAffectedByFacilities)$/,
  performance: /^(GenTypes|DirectXmlLoader|DirectXmlToObject\w*|LoadedModManager|ModContentPack|ModAssemblyHandler|XmlInheritance|PlayDataLoader|ContentFinder\w*|ModContentLoader\w*|ModContentHolder\w*|GraphicDatabase|MaterialPool|ShaderDatabase|GlobalTextureAtlasManager|AccessTools|StaticConstructorOnStartupUtility|LongEventHandler|DefGenerator|BackCompatibility|TickManager|TickList|RegionAndRoomUpdater|RegionTraverser|PathFinder|ListerThings|MemoryUtility|WorldPawns\w*|WorldPawnGC|GC\w*|ScribeLoader|ScribeSaver|Scribe_\w+|LanguageDatabase|LoadedLanguage|TKeySystem|GenText|Pawn_\w*Tracker_\w*Tick|ThingGrid|MapMeshFlag\w*|AudioSource\w*)$/,
  render: /^(PawnRenderer|PawnRenderTree|PawnRenderNode\w*|PawnRenderUtility|Graphic\w*|MapDrawer|Section|SectionLayer\w*|Printer_\w+|DynamicDrawManager|Mote\w*|OverlayDrawer|SkyManager|MatPool|Thing_DrawAt|PawnGraphicSet|ApparelGraphicRecordGetter)$/,
  job: /^(JobDriver\w*|WorkGiver\w*|JobGiver\w*|Toils\w*|HaulAIUtility|StoreUtility|ReservationManager|JobUtility|Pawn_JobTracker|ThinkNode\w*|FoodUtility|TendUtility|HealthAIUtility)$/,
  text_measure: /^(Text_CalcSize|Text_CalcHeight|Text)$/,
}
const SKIP_DLLS = /^(0harmony|harmony|hugslib|mono\.|system\.|microsoft\.|newtonsoft|unityengine|assembly-csharp|netstandard|mscorlib|fsharp\.core|jecstools|alienrace|vfecore|vanillaexpanded|ultimateframework)/i
const SKIP_DIRS = new Set(['source', 'src', 'sources', '.git', '.github', '.vs', '.vscode', 'obj', 'bin', 'node_modules', 'about', '_source', 'source code'])
const VERSION_DIR = /^v?(\d+\.\d+)(?:\b|$)/i
const LIMITS = { entries: 25000, xmlBytes: 2 * 1024 * 1024, totalXml: 40 * 1024 * 1024, dllBytes: 8 * 1024 * 1024, dlls: 8 }

/* ------------------------------------------------------------------ helpers */
const exists = (p) => stat(p).then(() => true, () => false)
const lc = (s) => String(s || '').toLowerCase()

/** Strip BBCode / HTML / urls and split into short quotable sentences. */
export function sentencesOf(text) {
  const clean = String(text || '')
    .replace(/\\[nr]/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[\/?[a-z*0-9]+(=[^\]]*)?\]/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
  return clean
    .split(/(?<=[.!?。！？；;])\s+|[\r\n]+|(?<=[。！？])/)
    .map((s) => s.replace(/\s+/g, ' ').replace(/^[-*•·>#\s]+/, '').trim())
    .filter((s) => s.length >= 6 && s.length <= 220 && /[\p{L}]/u.test(s))
}
const quote = (s) => (s.length > 120 ? s.slice(0, 117) + '…' : s)

/** Top-level children of <Defs> (depth 1), with attributes. Tolerant tag scanner. */
export function topLevelDefs(xml) {
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][\s\S]*?>|<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g
  const out = []
  let depth = 0
  let m
  while ((m = re.exec(xml))) {
    if (!m[2]) continue
    if (m[1]) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 1) out.push({ tag: m[2], attrs: m[3] || '' })
    if (!m[4]) depth++
  }
  return out
}

function parseLoadFoldersRaw(xml, major) {
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))
    return m ? m[1] : null
  }
  const block = pick('v' + major) || pick('default')
  if (block === null) return null
  const items = []
  for (const m of block.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<li([^>]*)>\s*([^<]*?)\s*<\/li>/g)) {
    const cond = m[1].match(/IfModActive\s*=\s*"([^"]+)"/i)
    const notCond = m[1].match(/IfModNotActive\s*=\s*"([^"]+)"/i)
    items.push({ dir: m[2] === '/' ? '' : m[2].replace(/^\/+|\/+$/g, ''), ifModActive: cond ? cond[1].split(/[,\s]+/).filter(Boolean) : [], ifModNotActive: !!notCond })
  }
  return items
}

/** Which folders the game will load for this mod (root + version folder, or LoadFolders.xml). */
async function loadedFolders(dir, major) {
  for (const n of ['LoadFolders.xml', 'loadFolders.xml', 'loadfolders.xml']) {
    const p = path.join(dir, n)
    if (await exists(p)) {
      const items = parseLoadFoldersRaw(await readFile(p, 'utf8').catch(() => ''), major)
      if (items && items.length) return { folders: items, loadFolders: true }
    }
  }
  const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const versions = names.filter((d) => d.isDirectory() && VERSION_DIR.test(d.name)).map((d) => ({ name: d.name, v: d.name.match(VERSION_DIR)[1] }))
  const num = (v) => v.split('.').map(Number).reduce((a, b) => a * 1000 + b, 0)
  const best = versions.filter((x) => !major || num(x.v) <= num(major)).sort((a, b) => num(b.v) - num(a.v))[0]
  const folders = [{ dir: '', ifModActive: [] }]
  if (best) folders.push({ dir: best.name, ifModActive: [] })
  if (names.some((d) => d.isDirectory() && d.name.toLowerCase() === 'common')) folders.push({ dir: names.find((d) => d.name.toLowerCase() === 'common').name, ifModActive: [] })
  return { folders, loadFolders: false }
}

async function walk(base, onFile, budget, { skipVersionDirs }) {
  const stack = [{ abs: base, rel: '' }]
  while (stack.length) {
    const { abs, rel } = stack.pop()
    let ents
    try {
      ents = await readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (--budget.entries < 0) return
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) {
        const low = e.name.toLowerCase()
        if (SKIP_DIRS.has(low)) continue
        if (!rel && skipVersionDirs && (VERSION_DIR.test(e.name) || low === 'common' || low === 'mods')) continue
        stack.push({ abs: path.join(abs, e.name), rel: r })
      } else if (e.isFile()) await onFile(path.join(abs, e.name), r)
    }
  }
}

/** Collect structural facts about a mod folder. */
export async function inspectModFolder(dir, major) {
  const f = {
    defs: {}, defFiles: 0, abstractDefs: 0, thingHints: { apparel: 0, weapon: 0, building: 0, furniture: 0, item: 0, food: 0, drug: 0, animal: 0, plant: 0, mech: 0 },
    patchFiles: 0, patchOps: 0, findModTargets: new Set(), mayRequire: new Set(), conditionalFolders: new Set(),
    langFiles: 0, defInjected: 0, keyed: 0, languages: new Set(), textures: 0, sounds: 0,
    dlls: [], dllHits: {}, dllExamples: {}, patched: new Set(), loadFolders: false, otherFiles: 0,
  }
  if (!dir || !(await exists(dir))) return f
  const { folders, loadFolders } = await loadedFolders(dir, major)
  f.loadFolders = loadFolders
  const budget = { entries: LIMITS.entries, xml: LIMITS.totalXml, dlls: LIMITS.dlls }
  const seen = new Set()
  for (const fo of folders) {
    const base = path.join(dir, fo.dir)
    if (seen.has(base)) continue
    seen.add(base)
    const conditional = fo.ifModActive.length > 0
    if (conditional) fo.ifModActive.forEach((m) => f.conditionalFolders.add(lc(m)))
    await walk(
      base,
      async (abs, rel) => {
        const parts = rel.split('/')
        const top = parts[0].toLowerCase()
        const ext = path.extname(abs).toLowerCase()
        if (top === 'languages') {
          f.langFiles++
          if (parts[1]) f.languages.add(parts[1])
          const sub = (parts[2] || '').toLowerCase()
          if (sub === 'definjected') f.defInjected++
          else if (sub === 'keyed' || sub === 'strings') f.keyed++
          return
        }
        if (top === 'textures') return void f.textures++
        if (top === 'sounds') return void f.sounds++
        if (top === 'assemblies' && ext === '.dll') {
          const name = path.basename(abs)
          if (SKIP_DLLS.test(name) || f.dlls.includes(name)) return
          f.dlls.push(name)
          if (budget.dlls-- > 0) await scanDll(abs, name, f)
          return
        }
        if (ext !== '.xml') return void f.otherFiles++
        if (top !== 'defs' && top !== 'patches') return
        let size = 0
        try {
          size = (await stat(abs)).size
        } catch {}
        if (size > LIMITS.xmlBytes || (budget.xml -= size) < 0) return
        const xml = await readFile(abs, 'utf8').catch(() => '')
        if (top === 'defs') scanDefs(xml, f, conditional)
        else scanPatches(xml, f)
      },
      budget,
      { skipVersionDirs: fo.dir === '' },
    )
  }
  return f
}

function scanDefs(xml, f, conditional) {
  f.defFiles++
  for (const d of topLevelDefs(xml)) {
    if (/Abstract\s*=\s*"true"/i.test(d.attrs)) {
      f.abstractDefs++
      continue
    }
    const mr = d.attrs.match(/MayRequire\s*=\s*"([^"]+)"/i)
    if (mr) mr[1].split(/[,\s]+/).filter(Boolean).forEach((x) => f.mayRequire.add(lc(x)))
    const key = conditional ? d.tag + '@cond' : d.tag
    f.defs[key] = (f.defs[key] || 0) + 1
  }
  const n = (re) => (xml.match(re) || []).length
  const h = f.thingHints
  h.apparel += n(/<apparel>/g)
  h.weapon += n(/<weaponTags>|<equipmentType>\s*Primary/g)
  h.building += n(/<building>|<designationCategory>/g)
  h.furniture += n(/<designationCategory>\s*(Furniture|Joy)\s*</g)
  h.food += n(/<ingestible>/g) - n(/<drugCategory>/g)
  h.drug += n(/<drugCategory>/g)
  h.animal += n(/<race>\s*(?![\s\S]{0,400}<humanlike>\s*true)/g)
  h.plant += n(/<plant>/g)
  h.mech += n(/<isMechanoid>\s*true|Mech_|MechanoidKind/g) > 0 ? 1 : 0
  h.item += n(/<category>\s*Item\s*</g)
  for (const m of xml.matchAll(/MayRequire\s*=\s*"([^"]+)"/gi)) m[1].split(/[,\s]+/).filter(Boolean).forEach((x) => f.mayRequire.add(lc(x)))
}

function scanPatches(xml, f) {
  f.patchFiles++
  f.patchOps += (xml.match(/<Operation\b|<li\s+Class\s*=\s*"PatchOperation/gi) || []).length
  for (const m of xml.matchAll(/PatchOperationFindMod[\s\S]*?<mods>([\s\S]*?)<\/mods>/gi)) for (const li of m[1].matchAll(/<li>\s*([^<]+?)\s*<\/li>/g)) f.findModTargets.add(li[1])
  for (const m of xml.matchAll(/MayRequire\s*=\s*"([^"]+)"/gi)) m[1].split(/[,\s]+/).filter(Boolean).forEach((x) => f.mayRequire.add(lc(x)))
}

async function scanDll(abs, name, f) {
  let buf
  try {
    const s = await stat(abs)
    if (s.size > LIMITS.dllBytes) return
    buf = await readFile(abs)
  } catch {
    return
  }
  const idents = new Set()
  for (const text of [buf.toString('latin1'), buf.toString('utf16le'), buf.subarray(1).toString('utf16le')]) for (const id of text.match(/[A-Za-z_][A-Za-z0-9_]{3,64}/g) || []) idents.add(id)
  for (const [sig, re] of Object.entries(DLL_SIGNALS)) {
    let hits = 0
    const ex = f.dllExamples[sig] || (f.dllExamples[sig] = [])
    for (const id of idents) {
      if (!re.test(id)) continue
      hits++
      if (ex.length < 4 && !ex.includes(id)) ex.push(id)
    }
    if (hits) f.dllHits[sig] = (f.dllHits[sig] || 0) + hits
  }
  // Harmony patch targets: "<Class>_<Method>_Patch" / "Patch_<Class>_<Method>" type names.
  for (const id of idents) {
    const m = id.match(/^(?:Patch_|HarmonyPatch_)?([A-Z][A-Za-z0-9]+(?:_[A-Z][A-Za-z0-9]+)?)_([A-Za-z0-9]+)(?:_Patch(?:es)?|_Prefix|_Postfix|_Transpiler)?$/)
    if (!m || !/_Patch|^Patch_|_Prefix$|_Postfix$|_Transpiler$/.test(id)) continue
    const cls = m[1].split('_')[0]
    const method = m[1].includes('_') ? m[1].split('_')[1] : m[2]
    f.patched.add(cls + '.' + method)
  }
}

/* ------------------------------------------------------------------ classification */
const KNOWN_LIBRARIES = new Set([
  'brrainz.harmony', 'zetrith.prepatcher', 'unlimitedhugs.hugslib', 'oskarpotocki.vanillafactionsexpanded.core', 'erdelf.humanoidalienraces',
  'jecrell.jecstools', 'imranfish.xmlextensions', 'smashphil.vehicleframework', 'aoba.framework', 'aoba.exosuit.framework', 'adaptive.storage.framework',
  'ebsg.framework', 'owlchemist.cherrypicker', 'redmattis.betterprerequisites', 'latta.fsharp.core', 'nals.facialanimation', 'dizhuan.sralib',
  'ancot.ancotlibrary', 'chezhou.chezhoulib.lib', 'eoralmilk.meowframework', 'oark.oberoniaaurea.framework', 'hailuan.customquestframework',
  'nozome.mapmodeframework', 'ariandel.ariandellibrary', 'chezhou.framework.rimsimmanagementframework', 'vanillaexpanded.vfecore',
])
const LIBRARY_DEPS = new Set(['brrainz.harmony', 'zetrith.prepatcher', 'unlimitedhugs.hugslib', 'ludeon.rimworld'])

// Defs that add behaviour but are not "new stuff" on their own (jobs, AI, text packs).
const LIGHT_DEFS = new Set(['JobDef', 'WorkGiverDef', 'JoyGiverDef', 'RulePackDef', 'DamageDef', 'MentalStateDef', 'ThoughtDef', 'ConceptDef', 'ThinkTreeDef', 'DutyDef', 'StatDef', 'StatCategoryDef', 'StuffCategoryDef'])
const isDlcOrLib = (k) => /^ludeon\./.test(k) || KNOWN_LIBRARIES.has(k)
const otherDepsOf = (mod) => (mod.modDependencies || []).map((d) => lc(d.packageId)).filter((k) => !LIBRARY_DEPS.has(k) && !isDlcOrLib(k))
const sum = (o, pred = () => true) => Object.entries(o).reduce((a, [k, v]) => a + (pred(k) ? v : 0), 0)
const baseTag = (k) => k.replace(/@cond$/, '')

/**
 * Classify one mod.
 * @param mod  catalog entry ({ key, packageId, name, author, description, supportedVersions, modDependencies })
 * @param f    inspectModFolder() result
 * @param ctx  { dependents: number, depKinds: { library: n, other: n }, names: Map<lc(name), key> }
 */
export function classifyMod(mod, f, ctx = {}) {
  const name = mod.name || mod.packageId || ''
  const sentences = sentencesOf(mod.description)
  const score = Object.fromEntries(TYPES.map((t) => [t, 0]))
  const ev = Object.fromEntries(TYPES.map((t) => [t, []]))
  const tags = new Set()
  const add = (type, pts, evidence) => {
    score[type] += pts
    if (evidence && !ev[type].includes(evidence)) ev[type].push(evidence)
  }
  const blobText = () => name + ' ' + sentences.slice(0, 12).join(' ')
  const descHit = (type) => sentences.find((s) => KW[type].desc.test(s))
  const descCount = (type) => sentences.filter((s) => KW[type].desc.test(s)).length

  const defsAll = sum(f.defs)
  const defsUncond = sum(f.defs, (k) => !k.endsWith('@cond'))
  const heavyDefs = sum(f.defs, (k) => CONTENT_DEFS.has(k) && !LIGHT_DEFS.has(k))
  const lightDefs = sum(f.defs, (k) => CONTENT_DEFS.has(k) && LIGHT_DEFS.has(k))
  // Weighted count of real new content (unconditional; conditional folders are compat content).
  // Mod-defined Def types (e.g. GeologicalLandforms.LandformDef) usually describe new content too.
  const customDefs = sum(f.defs, (k) => k.includes('.') && !k.endsWith('@cond') && !CONTENT_DEFS.has(k) && !/UpdateFeatureDef|Settings|Designator|KeyBinding/i.test(k))
  const musicDefs = sum(f.defs, (k) => k === 'SongDef')
  const contentDefs = Math.floor(heavyDefs + lightDefs * 0.25 + customDefs * 0.5 + musicDefs * 0.5)
  // Harmony patch targets grouped by what they touch.
  const patchCats = { ui: 0, performance: 0, render: 0, job: 0, other: 0 }
  const patchEx = { ui: [], performance: [], render: [], job: [], other: [] }
  for (const pm of f.patched || []) {
    const cls = pm.split('.')[0]
    const cat = Object.keys(PATCH_CLASS).find((c) => c !== 'text_measure' && PATCH_CLASS[c].test(cls)) || 'other'
    patchCats[cat]++
    if (patchEx[cat].length < 4) patchEx[cat].push(pm)
  }
  const patchedN = (f.patched && f.patched.size) || 0
  const codeCentric = contentDefs < 5
  const uiDefs = sum(f.defs, (k) => UI_DEFS.has(baseTag(k)))
  const hasDll = f.dlls.length > 0
  const compatTargets = new Set([...f.mayRequire, ...f.conditionalFolders, ...[...f.findModTargets].map(lc)])
  compatTargets.delete(lc(mod.key))
  for (const k of [...compatTargets]) if (isDlcOrLib(k)) compatTargets.delete(k)
  const defSummary = () =>
    Object.entries(f.defs)
      .map(([k, v]) => [baseTag(k), v])
      .reduce((m, [k, v]) => m.set(k, (m.get(k) || 0) + v), new Map())
  const topDefsText = () => [...defSummary()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join(', ')

  /* ---- translation (rule 9) */
  const onlyLanguages = f.langFiles > 0 && !hasDll && defsAll === 0 && f.patchOps <= 2 && f.textures < 5
  if (KW.translation.name.test(name)) add('translation', 3, `名称: ${name}`)
  // Credit lines ("Spanish translation by X") are common in normal mods: only count the
  // description when the mod has no code/content of its own.
  const trDesc = sentences.find((s) => KW.translation.desc.test(s) && !/(courtesy|thanks|credit|by \w+|感谢|提供)/i.test(s))
  if (trDesc && !hasDll && contentDefs === 0) add('translation', 2, quote(trDesc))
  if (onlyLanguages) add('translation', 5, `只有 Languages 文件: ${f.langFiles} 个 (${[...f.languages].slice(0, 3).join(', ')})`)
  else if (f.defInjected > 20 && contentDefs === 0 && !hasDll) add('translation', 2, `Languages/DefInjected: ${f.defInjected} 个文件`)
  if (score.translation > 0) {
    const zh = [...f.languages].some((l) => /chinese|中文|简体|繁體/i.test(l)) || /中文|汉化|漢化|\bzh\b|chinese/i.test(name)
    tags.add(zh ? 'translation_zh' : 'translation_other')
  }

  /* ---- library (rule 7) */
  if (KNOWN_LIBRARIES.has(mod.key)) add('library', 5, `常用前置: ${mod.packageId}`)
  if (KW.library.name.test(name)) add('library', /\bcore\b/i.test(name) && !/framework|librar|\blib|api|前置|框架/i.test(name) ? 1 : 3, `名称: ${name}`)
  if (descHit('library')) add('library', 2 + Math.min(1, descCount('library') - 1), quote(descHit('library')))
  if (ctx.dependents >= 3) add('library', ctx.dependents >= 10 ? 5 : 3, `被 ${ctx.dependents} 个已安装 mod 列为依赖`)
  else if (ctx.dependents >= 1) add('library', 0.5, `被 ${ctx.dependents} 个已安装 mod 列为依赖`)
  if (score.library > 0) tags.add(/framework|框架/i.test(name + ' ' + (mod.description || '').slice(0, 400)) ? 'framework' : 'api')

  /* ---- patch (rule 8) */
  if (KW.patch.name.test(name)) add('patch', 3, `名称: ${name}`)
  if (descHit('patch')) add('patch', 2, quote(descHit('patch')))
  // XML patches only count as "patch" when they look like compatibility work (rule 8):
  // no own code/content, or patches loaded conditionally on other mods.
  if (f.patchOps > 0 && contentDefs === 0 && !hasDll) add('patch', compatTargets.size || otherDepsOf(mod).length ? 2 : 1, `Patches: ${f.patchOps} 个 PatchOperation，无新增内容 Def`)
  if (compatTargets.size) {
    add('patch', compatTargets.size >= 3 ? 2 : 1, `按其他 mod 条件加载: ${[...compatTargets].slice(0, 4).join(', ')}${compatTargets.size > 4 ? ' …' : ''}`)
    tags.add('compatibility')
  }
  const otherDeps = otherDepsOf(mod)
  if (otherDeps.length && contentDefs < 5 && (f.patchOps > 0 || f.langFiles > 0 || f.textures > 0)) add('patch', 1, `依赖内容 mod: ${otherDeps.slice(0, 3).join(', ')}`)
  if (score.patch >= 3) tags.add('compatibility')

  /* ---- content (rule 6) */
  if (contentDefs > 0) {
    add('content', contentDefs >= 20 ? 6 : contentDefs >= 10 ? 4 : contentDefs >= 3 ? 2 : 1, `Defs: ${topDefsText()}`)
    if (KW.content.name.test(name)) add('content', 1, `名称: ${name}`)
    const d = descHit('content')
    if (d) add('content', 2, quote(d))
    if (f.textures > 30) add('content', 1, `Textures: ${f.textures} 张贴图`)
  } else if (!hasDll && defsAll === 0 && f.textures > 0 && f.langFiles === 0) {
    tags.add('retexture')
    add('content', 1, `只有贴图 (${f.textures} 张)，没有 Def/代码`)
  }

  /* ---- performance / ui / qol / utility */
  const dh = f.dllHits
  const dex = (sig) => (f.dllExamples[sig] || []).join(', ')
  if (KW.performance.name.test(name)) add('performance', 3, `名称: ${name}`)
  if (descHit('performance')) add('performance', 2 + Math.min(1, descCount('performance') - 1), quote(descHit('performance')))
  if (patchCats.performance) {
    add('performance', codeCentric ? Math.min(4, 1 + patchCats.performance) : 0.5, `Harmony 补丁原版加载/运算: ${patchEx.performance.join(', ')}`)
    tags.add('optimization')
  }
  if (codeCentric && hasDll && (dh.cache || 0) >= 3) tags.add('cache')
  if (codeCentric && hasDll && dh.optimization && patchCats.performance) tags.add('optimization')
  if (codeCentric && /\bcach(e|es|ing)\b|缓存/i.test(sentences.join(' '))) tags.add('cache')

  if (KW.ui.name.test(name)) add('ui', 3, `名称: ${name}`)
  if (descHit('ui')) add('ui', 2 + Math.min(1, descCount('ui') - 1), quote(descHit('ui')))
  if (uiDefs) add('ui', 2, `Defs: ${[...defSummary()].filter(([k]) => UI_DEFS.has(k)).map(([k, v]) => `${k}×${v}`).join(', ')}`)
  if (patchCats.ui) add('ui', codeCentric ? Math.min(4, 1 + Math.ceil(patchCats.ui / 2)) : 0.5, `Harmony 补丁原版界面: ${patchEx.ui.join(', ')}`)
  if (patchCats.render && codeCentric) {
    add(/performance|optimi|fps|优化|性能/i.test(blobText()) ? 'performance' : 'ui', 1, `Harmony 补丁原版渲染: ${patchEx.render.join(', ')}`)
    tags.add('render')
  }
  if (patchCats.job && codeCentric) {
    add('qol', 1, `Harmony 补丁原版工作/AI: ${patchEx.job.join(', ')}`)
    tags.add('joblogic')
  }
  // UI feature tags only for code-centric mods whose patches/defs/description really are UI.
  const uiCode = hasDll && codeCentric && (patchCats.ui > 0 || uiDefs > 0 || descHit('ui'))
  const uiSigs = uiCode ? ['menu', 'button', 'icon', 'tab', 'tooltip', 'pagination', 'text_measure'].filter((s) => (dh[s] || 0) >= (s === 'icon' || s === 'button' ? 3 : 1)) : []
  if ([...(f.patched || [])].some((p) => /^Text\.(CalcSize|CalcHeight)/.test(p))) uiSigs.push('text_measure')
  for (const s of new Set(uiSigs)) tags.add(s)
  if (uiDefs && [...defSummary()].some(([k]) => k === 'MainButtonDef')) tags.add('menu')
  if (hasDll && codeCentric && dh.sorting && /sort|order|排序/i.test(name + ' ' + sentences.slice(0, 6).join(' '))) tags.add('sorting')

  if (KW.qol.name.test(name)) add('qol', 2, `名称: ${name}`)
  if (descHit('qol')) add('qol', 2 + Math.min(1, descCount('qol') - 1), quote(descHit('qol')))
  if (KW.utility.name.test(name)) add('utility', 3, `名称: ${name}`)
  if (descHit('utility')) add('utility', 2, quote(descHit('utility')))
  const configurable = hasDll && (dh.settings || dh.toggle) && (f.dllExamples.settings || []).some((x) => /Settings/.test(x))
  if (configurable) {
    tags.add('settings')
    if (dh.toggle) tags.add('toggle')
  }

  if (hasDll && (dh.harmony || f.dlls.length)) tags.add('harmony')
  if (!hasDll && (defsAll || f.patchOps)) tags.add('xml_only')

  /* ---- feature tags from Defs and keywords */
  for (const [k] of defSummary()) if (DEF_TAG[k]) tags.add(DEF_TAG[k])
  const hint = f.thingHints
  if ((f.defs.ThingDef || 0) > 0) {
    for (const k of ['apparel', 'weapon', 'building', 'furniture', 'food', 'drug', 'plant', 'mech']) if (hint[k] > 0) tags.add(k)
    if (hint.animal > 0 && !tags.has('race')) tags.add('animal')
    if (hint.item > 0 && !hint.apparel && !hint.weapon) tags.add('item')
  }
  if (tags.has('ability') && /psycast|灵能/i.test(name + (mod.description || '').slice(0, 500))) tags.add('psycast')
  if (f.textures > 0 && contentDefs > 0) tags.add('texture')
  if (f.sounds > 0 && !tags.has('music')) tags.add('sound')
  const blob = blobText()
  for (const [tag, re] of FEATURE_KW) if (re.test(blob)) tags.add(tag)
  if (contentDefs === 0) for (const t of ['storage', 'medical']) if (tags.has(t) && !descHit('content')) tags.delete(t)

  /* ---- pick primary (rules 2, 3, 6-9) */
  const forbidContent = contentDefs === 0 && !tags.has('retexture')
  if (forbidContent) score.content = 0
  const order = ['translation', 'library', 'patch', 'content', 'performance', 'ui', 'utility', 'qol']
  const ranked = order.slice().sort((a, b) => score[b] - score[a] || order.indexOf(a) - order.indexOf(b))
  let primary = ranked[0]
  if (onlyLanguages && score.translation >= 5) primary = 'translation'
  if (score[primary] < 1) {
    // Nothing matched: decide from structure.
    primary = contentDefs > 0 ? 'content' : f.patchOps > 0 ? 'patch' : f.langFiles && !hasDll ? 'translation' : uiSigs.length ? 'ui' : hasDll ? 'qol' : 'utility'
    add(primary, 0.5, `结构推断: ${hasDll ? f.dlls.length + ' 个 DLL' : '无 DLL'}, ${defsUncond} 个 Def, ${f.patchOps} 个补丁操作`)
  }
  // Rule 3: code-only mod about caches/sorting/measuring/rendering/menus/buttons/icons -> performance or ui.
  if (contentDefs === 0 && hasDll && ['qol', 'utility'].includes(primary)) {
    const perfLike = (tags.has('cache') || tags.has('optimization') || tags.has('render') || tags.has('sorting')) && score.performance >= score.ui
    const uiLike = uiSigs.length && score.ui > 0
    if (perfLike && score.performance >= score[primary] - 1) primary = 'performance'
    else if (uiLike && score.ui >= score[primary] - 1) primary = 'ui'
  }

  /* ---- secondary types (rules 1, 4, 5) */
  const secondary = new Set(TYPES.filter((t) => t !== primary && score[t] >= (t === 'translation' || t === 'library' ? 3 : 2)))
  // A tool/UI mod that needs a couple of support Defs is not a content mod (rule 6 needs real new stuff).
  if (['ui', 'performance', 'utility', 'qol'].includes(primary) && contentDefs < 10 && !descHit('content')) secondary.delete('content')
  if (forbidContent) secondary.delete('content')
  if (['menu', 'button', 'icon', 'text_measure', 'pagination', 'tab', 'tooltip'].some((t) => tags.has(t)) && primary !== 'ui' && primary !== 'translation') secondary.add('ui') // rule 4
  if (tags.has('settings') || tags.has('toggle') || descHit('qol')) {
    // rule 5
    if (primary !== 'qol' && primary !== 'utility') secondary.add(score.utility > score.qol ? 'utility' : 'qol')
  }
  if (primary === 'translation') for (const t of [...secondary]) if (!['patch'].includes(t)) secondary.delete(t)
  if (primary === 'patch' && score.content < 3) secondary.delete('content')
  const secondaryList = [...secondary].sort((a, b) => score[b] - score[a]).slice(0, 3)

  /* ---- confidence */
  const s1 = score[primary]
  const s2 = Math.max(0, ...TYPES.filter((t) => t !== primary).map((t) => score[t]))
  let confidence = 0.3 + 0.06 * Math.min(s1, 8) + 0.07 * Math.min(Math.max(0, s1 - s2), 5)
  if (!sentences.length) confidence -= 0.08
  if (s1 < 2) confidence = Math.min(confidence, 0.4)
  confidence = Math.round(Math.max(0.15, Math.min(0.97, confidence)) * 100) / 100

  /* ---- evidence: primary first, then secondary, quotes from About.xml preferred */
  const evidence = []
  const push = (e) => e && !evidence.includes(e) && evidence.length < 8 && evidence.push(e)
  ev[primary].forEach(push)
  for (const t of secondaryList) ev[t].slice(0, 2).forEach(push)
  if (!evidence.length) push(`结构: ${f.dlls.length} 个 DLL, ${defsUncond} 个 Def, ${f.patchOps} 个补丁操作, ${f.langFiles} 个语言文件`)

  const featureTags = [...tags].filter((t) => TAG_ZH[t])
  const rankTag = (t) => (['race', 'faction', 'building', 'weapon', 'apparel', 'event', 'quest', 'map', 'gene', 'cache', 'render', 'menu', 'button', 'icon', 'settings', 'toggle', 'compatibility', 'translation_zh'].includes(t) ? 0 : t === 'harmony' || t === 'xml_only' ? 2 : 1)
  featureTags.sort((a, b) => rankTag(a) - rankTag(b))
  return finalize({
    mod_name: name,
    package_id: mod.packageId,
    author: mod.author || '',
    supported_versions: mod.supportedVersions || [],
    primary_type: primary,
    secondary_types: secondaryList,
    feature_tags: featureTags,
    confidence,
    evidence,
    source: 'auto',
    scores: Object.fromEntries(TYPES.map((t) => [t, Math.round(score[t] * 10) / 10])),
  })
}

/** Fill derived fields (booleans, display tags). Also validates an AI-provided verdict. */
export function finalize(r) {
  const primary = TYPES.includes(r.primary_type) ? r.primary_type : 'utility'
  const secondary = [...new Set((r.secondary_types || []).filter((t) => TYPES.includes(t) && t !== primary))]
  const features = [...new Set((r.feature_tags || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 16)
  const all = [primary, ...secondary]
  const display = r.display_tags_zh && r.display_tags_zh.length ? r.display_tags_zh.map(String).slice(0, 10) : [TYPE_ZH[primary], ...secondary.map((t) => TYPE_ZH[t]), ...features.map((t) => TAG_ZH[t] || t).slice(0, 6)]
  return {
    mod_name: r.mod_name || '',
    package_id: r.package_id || '',
    author: r.author || '',
    supported_versions: r.supported_versions || [],
    primary_type: primary,
    secondary_types: secondary,
    feature_tags: features,
    display_tags_zh: [...new Set(display)],
    is_content_mod: all.includes('content'),
    is_library: all.includes('library'),
    is_patch: all.includes('patch'),
    is_translation: all.includes('translation'),
    confidence: Math.round(Math.max(0, Math.min(1, Number(r.confidence) || 0)) * 100) / 100,
    evidence: (r.evidence || []).map((e) => String(e).slice(0, 200)).filter(Boolean).slice(0, 10),
    source: r.source === 'ai' || r.source === 'user' ? r.source : 'auto',
    ...(r.scores ? { scores: r.scores } : {}),
    ...(r.note ? { note: String(r.note).slice(0, 400) } : {}),
    ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
  }
}

/** Compact, human/AI readable summary of the raw folder facts. */
export function signalsSummary(f) {
  const defs = Object.entries(f.defs).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`)
  return {
    defs,
    patchOps: f.patchOps,
    conditionalOn: [...new Set([...f.mayRequire, ...f.conditionalFolders, ...[...f.findModTargets].map(lc)])].slice(0, 12),
    languages: [...f.languages].slice(0, 8),
    languageFiles: f.langFiles,
    textures: f.textures,
    sounds: f.sounds,
    dlls: f.dlls.slice(0, 8),
    dllSignals: Object.fromEntries(Object.entries(f.dllExamples).filter(([, v]) => v.length)),
    loadFolders: f.loadFolders,
  }
}

/** Persistent store: automatic results (cached by mod version) + AI overrides. */
export function createTagStore({ dataDir, readJson, writeJson }) {
  const file = path.join(dataDir, 'modTags.json')
  let data = null
  let dirty = false
  let timer = null
  const load = async () => {
    if (data) return data
    const d = await readJson(file).catch(() => null)
    data = { auto: d?.auto || {}, ai: d?.ai || {}, engine: d?.engine }
    if (data.engine !== ENGINE_VERSION) data.auto = {}
    data.engine = ENGINE_VERSION
    return data
  }
  const flush = async () => {
    clearTimeout(timer)
    timer = null
    if (!dirty || !data) return
    dirty = false
    await writeJson(file, data)
  }
  const later = () => {
    dirty = true
    if (!timer) timer = setTimeout(() => flush().catch(() => {}), 1500)
  }
  return {
    load,
    flush,
    async getAuto(key, version) {
      const d = await load()
      const e = d.auto[key]
      return e && e.version === version ? e : null
    },
    async setAuto(key, version, result, signals) {
      const d = await load()
      d.auto[key] = { version, result, signals }
      later()
    },
    async getAi(key) {
      return (await load()).ai[key] || null
    },
    async setAi(key, result) {
      const d = await load()
      d.ai[key] = result
      dirty = true
      await flush()
    },
    async clearAi(key) {
      const d = await load()
      if (!(key in d.ai)) return false
      delete d.ai[key]
      dirty = true
      await flush()
      return true
    },
    /** Drop every AI / user override (keys=null) or only the given keys. Returns how many were removed. */
    async clearAllAi(keys = null) {
      const d = await load()
      const list = keys ? keys.filter((k) => k in d.ai) : Object.keys(d.ai)
      for (const k of list) delete d.ai[k]
      if (list.length) {
        dirty = true
        await flush()
      }
      return list.length
    },
    async all() {
      const d = await load()
      return d
    },
  }
}
export const ENGINE_VERSION = 1
