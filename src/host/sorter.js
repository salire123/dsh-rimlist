/**
 * Load-order sorter and diagnostics.
 *
 * Sorting model (close to RimSort's "topological" sort):
 *   tier 0  Core + official expansions + anything that must load before them (Harmony, loaders)
 *   tier 1  mods flagged loadTop (frameworks: XML Extensions, ...)
 *   tier 2  everything else
 *   tier 3  mods flagged loadBottom (RocketMan, patch collections, ...)
 * Edges (A must load before B) come from, in priority order:
 *   forceLoadBefore/After (About.xml)  >  user rules  >  About.xml loadAfter/Before
 *   >  community rules  >  modDependencies (dependency loads before dependent).
 * Inside a tier a Kahn topological sort picks, among mods whose constraints are
 * satisfied, the one that comes first by the tie-break (lowest priority):
 *   tieBreak 'name'    -> alphabetical by mod name (RimSort-like, deterministic)
 *   tieBreak 'current' -> keep the current relative order
 * Either way re-sorting an already sorted list is a no-op.
 * Cycles are broken by dropping the lowest-priority edge of the cycle and
 * reported in diagnostics.
 */
import { pid } from './xml.js'
import { CORE_ID, KNOWN_EXPANSIONS } from './scan.js'

const EXPANSION_ORDER = ['ludeon.rimworld.royalty', 'ludeon.rimworld.ideology', 'ludeon.rimworld.biotech', 'ludeon.rimworld.anomaly', 'ludeon.rimworld.odyssey']
const PRIORITY = { force: 0, user: 1, about: 2, community: 3, dependency: 4 }

function tierOf(mod, rules) {
  if (mod.key === CORE_ID) return 0
  if (mod.kind === 'expansion' || mod.key in KNOWN_EXPANSIONS) return 0
  if (rules.loadTop) return 1
  if (rules.loadBottom) return 3
  return 2
}

/**
 * Build the constraint graph for the given active ids.
 * Returns { edges: Map<"a>b", {from,to,source,priority,comment}>, tiers: Map<key, tier> }.
 */
export function buildGraph(activeKeys, catalog, ruleStore) {
  const active = new Set(activeKeys)
  const edges = new Map()
  const tiers = new Map()
  const addEdge = (before, after, source, comment) => {
    const a = pid(before)
    const b = pid(after)
    if (!active.has(a) || !active.has(b) || a === b) return
    const k = a + '>' + b
    const prev = edges.get(k)
    if (!prev || PRIORITY[source] < PRIORITY[prev.source]) edges.set(k, { from: a, to: b, source, priority: PRIORITY[source], comment })
  }
  for (const key of active) {
    const mod = catalog.get(key)
    const rules = ruleStore ? ruleStore.rulesFor(key) : { loadAfter: {}, loadBefore: {}, incompatibleWith: {} }
    tiers.set(key, mod ? tierOf(mod, rules) : 3)
    if (!mod) continue
    for (const t of mod.forceLoadAfter) addEdge(t, key, 'force')
    for (const t of mod.forceLoadBefore) addEdge(key, t, 'force')
    for (const t of mod.loadAfter) addEdge(t, key, 'about')
    for (const t of mod.loadBefore) addEdge(key, t, 'about')
    for (const d of mod.modDependencies) addEdge(d.packageId, key, 'dependency')
    for (const [t, info] of Object.entries(rules.loadAfter)) addEdge(t, key, info.source === 'user' ? 'user' : 'community', info.comment)
    for (const [t, info] of Object.entries(rules.loadBefore)) addEdge(key, t, info.source === 'user' ? 'user' : 'community', info.comment)
  }
  // Expansions: keep Ludeon's canonical order even if About.xml lacks force rules.
  for (const e of EXPANSION_ORDER) addEdge(CORE_ID, e, 'force')
  for (let i = 0; i < EXPANSION_ORDER.length - 1; i++) for (let j = i + 1; j < EXPANSION_ORDER.length; j++) addEdge(EXPANSION_ORDER[i], EXPANSION_ORDER[j], 'force')

  // Promote into tier 0 anything that must load before a tier-0 mod (Harmony and
  // loaders declare loadBefore Core). Iterate to a fixpoint for chains.
  let changed = true
  while (changed) {
    changed = false
    for (const e of edges.values()) {
      if (tiers.get(e.to) === 0 && tiers.get(e.from) !== 0) {
        tiers.set(e.from, 0)
        changed = true
      }
    }
  }
  return { edges, tiers }
}

/** Stable Kahn sort with cycle breaking. `order` provides tie-breaking (current positions). */
function topo(keys, edgeList, order) {
  const pos = new Map(keys.map((k, i) => [k, order.has(k) ? order.get(k) : 1e9 + i]))
  const indeg = new Map(keys.map((k) => [k, 0]))
  const out = new Map(keys.map((k) => [k, []]))
  const set = new Set(keys)
  let edges = edgeList.filter((e) => set.has(e.from) && set.has(e.to))
  const broken = []

  const run = () => {
    for (const k of keys) {
      indeg.set(k, 0)
      out.set(k, [])
    }
    for (const e of edges) {
      indeg.set(e.to, indeg.get(e.to) + 1)
      out.get(e.from).push(e.to)
    }
    const ready = keys.filter((k) => indeg.get(k) === 0).sort((a, b) => pos.get(a) - pos.get(b))
    const result = []
    while (ready.length) {
      const k = ready.shift()
      result.push(k)
      for (const n of out.get(k)) {
        indeg.set(n, indeg.get(n) - 1)
        if (indeg.get(n) === 0) {
          // insert keeping ready sorted by original position
          let i = 0
          while (i < ready.length && pos.get(ready[i]) <= pos.get(n)) i++
          ready.splice(i, 0, n)
        }
      }
    }
    return result
  }

  let result = run()
  let guard = 0
  while (result.length < keys.length && guard++ < 200) {
    // Find one cycle among remaining nodes and drop its weakest edge.
    const remaining = new Set(keys.filter((k) => !result.includes(k)))
    const cycEdges = edges.filter((e) => remaining.has(e.from) && remaining.has(e.to))
    const cycle = findCycle(cycEdges, remaining)
    if (!cycle.length) break
    const weakest = cycle.reduce((w, e) => (e.priority >= w.priority ? e : w))
    broken.push({ cycle: cycle.map((e) => e.from + ' → ' + e.to), dropped: weakest })
    edges = edges.filter((e) => e !== weakest)
    result = run()
  }
  if (result.length < keys.length) for (const k of keys) if (!result.includes(k)) result.push(k)
  return { order: result, broken }
}

function findCycle(edges, nodes) {
  const adj = new Map()
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from).push(e)
  }
  const state = new Map()
  const stack = []
  let found = null
  const dfs = (n) => {
    if (found) return
    state.set(n, 1)
    for (const e of adj.get(n) || []) {
      if (found) return
      if (state.get(e.to) === 1) {
        const i = stack.findIndex((x) => x.from === e.to)
        found = [...stack.slice(i), e]
        return
      }
      if (!state.has(e.to)) {
        stack.push(e)
        dfs(e.to)
        stack.pop()
      }
    }
    state.set(n, 2)
  }
  for (const n of nodes) {
    if (found) break
    if (!state.has(n)) dfs(n)
  }
  return found || []
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const sortName = (k, catalog) => (catalog.get(k)?.name || k).trim()
/** Keys ranked by the lowest-priority criterion. */
export function tieBreakOrder(keys, catalog, tieBreak = 'name') {
  if (tieBreak !== 'name') return [...keys]
  return [...keys].sort((a, b) => collator.compare(sortName(a, catalog), sortName(b, catalog)) || collator.compare(a, b))
}

/**
 * Faithful port of RimSort's "Topological" sort (app/controllers/sort_controller.py,
 * app/sort/topo_sort.py, CompiledDependencyData.build) with
 * use_moddependencies_as_loadTheseBefore = true:
 *   - one graph = union of About.xml + community + user loadAfter/loadBefore (no priorities)
 *   - modDependencies added as loadAfter unless an explicit rule says the opposite
 *   - tier0 = known Ludeon/Harmony ids + their recursive deps; tier1 = known frameworks
 *     + loadTop + their recursive deps; tier3 = loadBottom + everything that loads after them
 *   - per tier: level-by-level toposort, each level sorted by lowercase name
 * On a cycle RimSort refuses to sort; we fall back to the priority-aware greedy sort.
 *
 * Derived from RimSort (https://github.com/RimSort/RimSort), licensed under GPL-3.0.
 * Ported to JavaScript and modified for dsh-rimlist (2026).
 */
const RS_TIER0 = ['zetrith.prepatcher', 'brrainz.harmony', 'brrainz.visualexceptions', 'ludeon.rimworld', 'ludeon.rimworld.royalty', 'ludeon.rimworld.ideology', 'ludeon.rimworld.biotech', 'ludeon.rimworld.anomaly', 'ludeon.rimworld.odyssey']
const RS_TIER1 = ['adaptive.storage.framework', 'aoba.framework', 'aoba.exosuit.framework', 'ebsg.framework', 'imranfish.xmlextensions', 'thesepeople.ritualattachableoutcomes', 'ohno.asf.ab.local', 'oskarpotocki.vanillafactionsexpanded.core', 'owlchemist.cherrypicker', 'redmattis.betterprerequisites', 'smashphil.vehicleframework', 'unlimitedhugs.hugslib', 'vanillaexpanded.backgrounds']

export function sortRimSort(activeKeys, catalog, ruleStore) {
  const keys = [...new Set(activeKeys.map(pid))]
  const active = new Set(keys)
  const deps = new Map(keys.map((k) => [k, new Set()])) // k -> mods that must load before k
  const rev = new Map(keys.map((k) => [k, new Set()]))
  const add = (after, before) => {
    const a = pid(after)
    const b = pid(before)
    if (!active.has(a) || !active.has(b) || a === b) return
    deps.get(a).add(b)
    rev.get(b).add(a)
  }
  const tier1 = new Set(RS_TIER1)
  const tier3 = new Set()
  const R = (k) => (ruleStore ? ruleStore.rulesFor(k) : { loadAfter: {}, loadBefore: {} })
  for (const k of keys) {
    const m = catalog.get(k)
    const r = R(k)
    for (const t of [...(m?.loadAfter || []), ...(m?.forceLoadAfter || []), ...Object.keys(r.loadAfter || {})]) add(k, t)
    for (const t of [...(m?.loadBefore || []), ...(m?.forceLoadBefore || []), ...Object.keys(r.loadBefore || {})]) add(t, k)
    if (r.loadTop && !RS_TIER0.includes(k)) tier1.add(k)
    if (r.loadBottom) tier3.add(k)
  }
  for (const k of keys) {
    if (tier1.has(k) || tier3.has(k)) continue
    for (const d of catalog.get(k)?.modDependencies || []) {
      const dk = pid(d.packageId)
      if (!active.has(dk) || tier1.has(dk) || tier3.has(dk)) continue
      if (deps.get(dk).has(k)) continue // explicit rule wins over the inferred dependency
      add(k, dk)
    }
  }
  const closure = (seeds, g) => {
    const out = new Set()
    const stack = [...seeds].filter((k) => active.has(k))
    for (const k of stack) out.add(k)
    while (stack.length) for (const n of g.get(stack.pop()) || []) if (!out.has(n)) { out.add(n); stack.push(n) }
    return out
  }
  const t0 = closure(RS_TIER0, deps)
  const t1 = closure(tier1, deps)
  const t3 = closure(tier3, rev)
  const t2 = new Set(keys.filter((k) => !t0.has(k) && !t1.has(k) && !t3.has(k)))
  const nameKey = (k) => (catalog.get(k)?.aboutName || catalog.get(k)?.name || 'name error in mod about.xml').toLowerCase()
  const cmp = (a, b) => { const x = nameKey(a); const y = nameKey(b); return x < y ? -1 : x > y ? 1 : 0 }
  const order = []
  for (const tier of [t0, t1, t2, t3]) {
    const left = new Map([...tier].map((k) => [k, new Set([...deps.get(k)].filter((d) => tier.has(d)))]))
    while (left.size) {
      const level = [...left.keys()].filter((k) => left.get(k).size === 0)
      if (!level.length) {
        // cycle: RimSort aborts ("Unable to Sort"); fall back to the greedy sorter
        const r = sortLoadOrder(keys, catalog, ruleStore, { tieBreak: 'name' })
        return { ...r, rimsortCycle: [...left.keys()] }
      }
      level.sort(cmp)
      for (const k of level) left.delete(k)
      for (const s of left.values()) for (const k of level) s.delete(k)
      order.push(...level)
    }
  }
  const seen = new Set()
  const final = order.filter((k) => !seen.has(k) && seen.add(k))
  const { edges } = buildGraph(keys, catalog, ruleStore)
  const posAfter = new Map(final.map((k, i) => [k, i]))
  const crossTierViolations = [...edges.values()].filter((e) => posAfter.get(e.from) > posAfter.get(e.to)).map((e) => ({ ...e }))
  let moved = 0
  for (let i = 0; i < final.length; i++) if (final[i] !== keys[i]) moved++
  return { order: final, moved, broken: [], crossTierViolations }
}

/**
 * Sort the active list. Returns { order: string[], moved: number, broken: [...] }.
 * `activeKeys` is the current order (already lowercase keys).
 * tieBreak: 'rimsort' = exact RimSort "Topological" algorithm (see sortRimSort),
 *           'name' / 'current' = our priority-aware greedy sort.
 */
export function sortLoadOrder(activeKeys, catalog, ruleStore, { tieBreak = 'name' } = {}) {
  if (tieBreak === 'rimsort') return sortRimSort(activeKeys, catalog, ruleStore)
  const keys = [...new Set(activeKeys.map(pid))]
  const { edges, tiers } = buildGraph(keys, catalog, ruleStore)
  const current = new Map(tieBreakOrder(keys, catalog, tieBreak).map((k, i) => [k, i]))
  const byTier = [[], [], [], []]
  for (const k of keys) byTier[tiers.get(k) ?? 2].push(k)
  const edgeList = [...edges.values()]
  const order = []
  const broken = []
  for (const tier of byTier) {
    if (!tier.length) continue
    const r = topo(tier, edgeList, current)
    order.push(...r.order)
    broken.push(...r.broken)
  }
  // Cross-tier edges that are violated (e.g. a loadBottom mod required before a tier-3 mod) are reported, not enforced.
  const posAfter = new Map(order.map((k, i) => [k, i]))
  const crossTierViolations = edgeList.filter((e) => posAfter.get(e.from) > posAfter.get(e.to)).map((e) => ({ ...e }))
  let moved = 0
  for (let i = 0; i < order.length; i++) if (order[i] !== keys[i]) moved++
  return { order, moved, broken, crossTierViolations }
}

/**
 * Key of the installed copy of a "Use This Instead" replacement, or null.
 * Workshop id is authoritative; packageId is only used when it differs from the old mod's.
 */
export function findInstalledReplacement(rep, catalog, oldKey) {
  if (!rep) return null
  if (rep.newPfid) {
    for (const [key, m] of catalog) if (key !== oldKey && m?.publishedFileId && String(m.publishedFileId) === String(rep.newPfid)) return key
  }
  const np = rep.newPackageId ? pid(rep.newPackageId) : ''
  if (np && np !== oldKey && catalog.has(np)) return np
  return null
}

/**
 * Diagnose an active list against catalog + rules. Each issue:
 *   { level: 'error'|'warning'|'info', code, mod, target?, message, fix? }
 */
export function diagnose(activeKeys, catalog, ruleStore, { gameMajor, duplicates = [] } = {}) {
  const keys = activeKeys.map(pid)
  const active = new Set(keys)
  const posOf = new Map(keys.map((k, i) => [k, i]))
  const pairs = new Set()
  /** true the first time an unordered pair is seen (so each incompatibility is reported once). */
  const seenPair = (a, b) => {
    const id = a < b ? a + '|' + b : b + '|' + a
    if (pairs.has(id)) return false
    pairs.add(id)
    return true
  }
  const issues = []
  const nameOf = (k) => catalog.get(k)?.name || ruleStore?.steamByPid(k)?.name || k
  const push = (level, code, mod, message, extra = {}) => issues.push({ level, code, mod, modName: nameOf(mod), message, ...extra })

  if (!active.has(CORE_ID)) push('error', 'missing-core', CORE_ID, 'Core (ludeon.rimworld) is not active')

  for (const k of keys) {
    const mod = catalog.get(k)
    if (!mod) {
      const steam = ruleStore?.steamByPid(k)
      push('error', 'missing-mod', k, `Active mod is not installed: ${k}`, { steam: steam ? { pfid: steam.pfid, url: steam.url, name: steam.name } : null, fix: 'unsub-or-remove' })
      continue
    }
    if (mod.invalid) push('warning', 'invalid-about', k, mod.invalid)
    // version
    if (gameMajor && mod.kind === 'mod') {
      const supports = mod.supportedVersions.includes(gameMajor) || mod.loadFolderVersions.includes(gameMajor)
      if (!supports) {
        const nvw = ruleStore?.nvwCovers(k)
        push(nvw ? 'info' : 'warning', nvw ? 'version-nvw' : 'version-mismatch', k,
          nvw ? `Not tagged for ${gameMajor}, but NoVersionWarning marks it as working` : `Does not declare support for RimWorld ${gameMajor} (declares ${mod.supportedVersions.join(', ') || 'none'})`)
      }
    }
    // "Use This Instead": a maintained replacement exists
    const rep = ruleStore?.replacementFor?.({ publishedFileId: mod.publishedFileId, packageId: k })
    const installedKey = rep ? findInstalledReplacement(rep, catalog, k) : null
    if (rep && rep.newPfid && rep.newPfid !== mod.publishedFileId && !(rep.newPackageId && active.has(rep.newPackageId)) && !(installedKey && active.has(installedKey))) {
      push('info', 'use-this-instead', k, `A maintained replacement exists: "${rep.newName}"${rep.newAuthor ? ' by ' + rep.newAuthor : ''}${rep.newVersions?.length ? ' (' + rep.newVersions.slice(-2).join(', ') + ')' : ''}`, {
        target: installedKey || rep.newPackageId || undefined,
        targetName: rep.newName,
        steam: { pfid: rep.newPfid, url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${rep.newPfid}` },
        // Already downloaded → it can be swapped in directly; otherwise subscribe on Steam first.
        installedKey: installedKey || undefined,
        fix: installedKey ? 'replace' : 'subscribe',
      })
    }
    // dependencies
    for (const d of mod.modDependencies) {
      const dk = pid(d.packageId)
      if (!active.has(dk)) {
        const installed = catalog.has(dk)
        const steam = ruleStore?.steamByPid(dk)
        const pfidFromUrl = d.steamWorkshopUrl?.match(/(\d{6,})/)?.[1] || null
        push('error', installed ? 'dependency-inactive' : 'dependency-missing', k,
          installed ? `Requires "${d.displayName}" (${dk}) which is installed but not active` : `Requires "${d.displayName}" (${dk}) which is not installed`,
          { target: dk, targetName: d.displayName, steam: { pfid: steam?.pfid || pfidFromUrl, url: steam?.url || d.steamWorkshopUrl || d.downloadUrl }, fix: installed ? 'activate' : 'subscribe' })
      } else if (posOf.get(dk) > posOf.get(k)) {
        push('warning', 'order-dependency', k, `Should load after its dependency "${nameOf(dk)}"`, { target: dk, fix: 'sort' })
      }
    }
    // explicit order rules (About.xml)
    for (const t of mod.loadAfter.map(pid)) if (active.has(t) && posOf.get(t) > posOf.get(k)) push('warning', 'order-about', k, `About.xml says load after "${nameOf(t)}"`, { target: t, fix: 'sort' })
    for (const t of mod.loadBefore.map(pid)) if (active.has(t) && posOf.get(t) < posOf.get(k)) push('warning', 'order-about', k, `About.xml says load before "${nameOf(t)}"`, { target: t, fix: 'sort' })
    for (const t of mod.forceLoadAfter.map(pid)) if (active.has(t) && posOf.get(t) > posOf.get(k)) push('error', 'order-force', k, `Must load after "${nameOf(t)}"`, { target: t, fix: 'sort' })
    for (const t of mod.forceLoadBefore.map(pid)) if (active.has(t) && posOf.get(t) < posOf.get(k)) push('error', 'order-force', k, `Must load before "${nameOf(t)}"`, { target: t, fix: 'sort' })
    // incompatibilities (About.xml)
    for (const t of mod.incompatibleWith.map(pid)) if (active.has(t) && seenPair(k, t) && !ruleStore?.ignoresIncompatible?.(k, t)) push('error', 'incompatible', k, `Incompatible with "${nameOf(t)}" (About.xml)`, { target: t, fix: 'ignore' })
    // rules DB
    if (ruleStore) {
      const r = ruleStore.rulesFor(k)
      for (const [t, info] of Object.entries(r.incompatibleWith)) if (active.has(t) && seenPair(k, t) && info.source !== 'user' && !ruleStore.ignoresIncompatible(k, t)) push('error', 'incompatible', k, `Incompatible with "${nameOf(t)}" (${info.source} rules${info.comment ? ': ' + info.comment : ''})`, { target: t, source: info.source, fix: 'ignore' })
      for (const [t, info] of Object.entries(r.incompatibleWith)) if (active.has(t) && info.source === 'user' && seenPair(k, t)) push('error', 'incompatible', k, `Incompatible with "${nameOf(t)}" (your rule${info.comment ? ': ' + info.comment : ''})`, { target: t, source: 'user' })
      for (const [t, info] of Object.entries(r.loadAfter)) if (active.has(t) && posOf.get(t) > posOf.get(k)) push('warning', 'order-rule', k, `${info.source} rules: load after "${nameOf(t)}"${info.comment ? ' — ' + info.comment : ''}`, { target: t, source: info.source, fix: 'sort' })
      for (const [t, info] of Object.entries(r.loadBefore)) if (active.has(t) && posOf.get(t) < posOf.get(k)) push('warning', 'order-rule', k, `${info.source} rules: load before "${nameOf(t)}"${info.comment ? ' — ' + info.comment : ''}`, { target: t, source: info.source, fix: 'sort' })
      // Steam DB dependencies (catches deps declared only on the workshop page)
      const steam = mod.publishedFileId ? ruleStore.steamByPfid(mod.publishedFileId) : null
      if (steam) {
        for (const [depPfid, depName] of Object.entries(steam.dependencies)) {
          const dep = ruleStore.steamByPfid(depPfid)
          if (!dep || dep.isApp) continue // DLC deps handled via knownExpansions; skip
          if (dep.packageId && !active.has(dep.packageId) && !mod.modDependencies.some((d) => pid(d.packageId) === dep.packageId)) {
            push('warning', 'steam-dependency', k, `Workshop page lists "${depName}" as required, which is not active`, { target: dep.packageId, targetName: depName, steam: { pfid: depPfid, url: dep.url }, fix: catalog.has(dep.packageId) ? 'activate' : 'subscribe' })
          }
        }
      }
    }
  }
  for (const d of duplicates) if (active.has(d.key)) push('info', 'duplicate', d.key, `Installed ${d.paths.length} times; using ${d.paths[0]}`, { paths: d.paths })

  const counts = { error: 0, warning: 0, info: 0 }
  for (const i of issues) counts[i.level]++
  return { issues, counts }
}
