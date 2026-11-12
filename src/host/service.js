/**
 * RimList service: one in-memory state, serialized mutations, a `dispatch`
 * entry point shared by the HTTP route and the AI tools.
 */
import { copyFile, mkdir, readFile, writeFile, rename, readdir, stat, unlink, rm } from 'node:fs/promises'
import path from 'node:path'
import { discoverPaths, readGameVersion, exists, findGameExecutable } from './paths.js'
import { launchGame, resolveLaunch, openWorkshopPage, subscribeSteamWorkshop, unsubscribeSteamWorkshop } from './launch.js'
import { gameStatus, stopGame } from './process.js'
import { findLogFile, readLogFile, parseLog, summarize, summaryToText, attributeMods } from './gamelog.js'
import { readWorkshopState, createChangelogCache, createBackupStore, gitInfo, gitCheck, gitRecentLog, runGit, normalizeGitUrl, repoName } from './modversions.js'
import { scanMods } from './scan.js'
import { parseModsConfig, buildModsConfig, pid } from './xml.js'
import { createRuleStore, DEFAULT_DB_CONFIG, DB_KEYS } from './rules.js'
import { homedir } from 'node:os'
import { sortLoadOrder, diagnose, buildGraph } from './sorter.js'
import { createListStore, cleanGit } from './lists.js'
import { inspectModFolder, classifyMod, finalize, signalsSummary, createTagStore } from './classify.js'
import { initLogger, debugLog } from './logger.js'
import { createSaveStore, defaultSavesDir } from './saves.js'

const SETTINGS_FILE = 'settings.json'
const DEFAULT_SETTINGS = {
  gameDir: null,
  configDir: null,
  workshopDir: null,
  localModsDir: null,
  // RimWorld Saves folder (null = <config dir>/../Saves)
  savesDir: null,
  extraModDirs: [],
  databases: DEFAULT_DB_CONFIG,
  userRulesEnabled: true,
  // Lowest-priority sort criterion for mods with no constraint between them: name | current
  sortTieBreak: 'name',
  dbMaxAgeHours: 24 * 7,
  backupKeep: 20,
  // Mod snapshots (Steam Workshop can't roll back): auto = snapshot active workshop mods' current version on scan.
  modBackup: { auto: false, keep: 3, onlyActive: true },
  authorName: '',
  // Where workshop links open: steam (the Steam client, can subscribe directly) | browser
  workshopOpen: 'steam',
  // How the "Start game" button runs RimWorld: steam | direct | custom
  launch: { mode: 'steam', steamPath: '', executable: '', command: '', args: '', saveFirst: true },
  // Data directory location (settings, backups, cache) - cannot be changed at runtime, shown for reference
  // dataDir: null, // Read-only, set via DSH_HOME env or default ~/.dsh/rimlist
}

export function createService({ dataDir, log = () => {}, fetchImpl }) {
  // Initialize debug logger
  initLogger(dataDir, true)
  debugLog('service', 'createService called, dataDir:', dataDir)
  
  const rules = createRuleStore({ dataDir, log, fetchImpl })
  const changelogs = createChangelogCache({ dataDir, fetchImpl: fetchImpl || globalThis.fetch, log })
  const modBackups = createBackupStore({ dataDir })
  const lists = createListStore({ dataDir })
  const saves = createSaveStore()
  const modTags = createTagStore({ dataDir, readJson: async (p) => JSON.parse(await readFile(p, 'utf8')), writeJson: async (p, v) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p + '.tmp', JSON.stringify(v, null, 2)); await rename(p + '.tmp', p) } })
  const modNotes = createNoteStore({ dataDir, readJson: async (p) => JSON.parse(await readFile(p, 'utf8')), writeJson: async (p, v) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p + '.tmp', JSON.stringify(v, null, 2)); await rename(p + '.tmp', p) } })

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    discovered: null,
    game: null, // { full, major }
    catalog: new Map(),
    mods: [],
    duplicates: [],
    scannedAt: null,
    config: null, // parsed ModsConfig { version, activeMods, knownExpansions }
    configMtime: 0,
    ready: null,
  }
  let queue = Promise.resolve()
  const serialize = (fn) => {
    const p = queue.then(fn, fn)
    queue = p.catch(() => {})
    return p
  }

  // ---- settings ----
  const settingsPath = path.join(dataDir, SETTINGS_FILE)
  const loadSettings = async () => {
    try {
      const s = JSON.parse(await readFile(settingsPath, 'utf8'))
      state.settings = { ...DEFAULT_SETTINGS, ...s, databases: mergeDb(s.databases), launch: { ...DEFAULT_SETTINGS.launch, ...(s.launch || {}) }, modBackup: { ...DEFAULT_SETTINGS.modBackup, ...(s.modBackup || {}) } }
      // Migrate the old boolean `rules` toggles.
      if (s.rules && !s.databases) for (const [k, v] of Object.entries(s.rules)) if (k in state.settings.databases && v === false) state.settings.databases[k].mode = 'none'
      if (s.rules && typeof s.rules.user === 'boolean') state.settings.userRulesEnabled = s.rules.user
      delete state.settings.rules
      // Migrate: SteamCMD support was removed. Older versions may have stored its settings
      // (including a plain-text Steam password) here, so scrub them from disk.
      if ('steamcmd' in state.settings) {
        delete state.settings.steamcmd
        await saveSettings().catch(() => {})
      }
    } catch {}
    applyDbConfig()
  }
  const mergeDb = (d) => {
    const out = JSON.parse(JSON.stringify(DEFAULT_DB_CONFIG))
    for (const k of DB_KEYS) if (d && d[k] && typeof d[k] === 'object') out[k] = { ...out[k], ...d[k] }
    return out
  }
  const applyDbConfig = () => {
    rules.configure(state.settings.databases)
    rules.setEnabled('user', state.settings.userRulesEnabled !== false)
  }
  const persistableSettings = () => {
    const { steamcmd, ...rest } = state.settings
    return rest
  }
  const publicSettings = () => persistableSettings()
  const saveSettings = async () => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(settingsPath + '.tmp', JSON.stringify(persistableSettings(), null, 2), { mode: 0o600 })
    await rename(settingsPath + '.tmp', settingsPath)
  }
  const effectivePaths = () => {
    const d = state.discovered || {}
    const s = state.settings
    const gameDir = s.gameDir || d.gameDir || null
    const configDir = s.configDir || d.configDir || null
    return {
      gameDir,
      configDir,
      savesDir: s.savesDir || defaultSavesDir(configDir),
      workshopDir: s.workshopDir || d.workshopDir || null,
      localModsDir: s.localModsDir || d.localModsDir || (gameDir ? path.join(gameDir, 'Mods') : null),
      extraModDirs: s.extraModDirs || [],
    }
  }
  const modsConfigPath = () => {
    const p = effectivePaths()
    return p.configDir ? path.join(p.configDir, 'ModsConfig.xml') : null
  }

  // ---- scanning ----
  const rescan = async () => {
    state.discovered = await discoverPaths()
    const p = effectivePaths()
    state.game = await readGameVersion(p.gameDir)
    const r = await scanMods({ ...p, major: state.game?.major, extraDirs: p.extraModDirs })
    state.catalog = r.byId
    state.mods = r.mods
    state.duplicates = r.duplicates
    state.scannedAt = Date.now()
    await loadConfig()
    state.workshop = await readWorkshopState(p.workshopDir).catch(() => ({ items: new Map() }))
    await trackVersions().catch((e) => log('version tracking: ' + e.message))
    return { count: r.mods.length }
  }
  const loadConfig = async () => {
    const f = modsConfigPath()
    if (!f || !(await exists(f))) {
      state.config = { version: state.game?.full || '', activeMods: [], knownExpansions: [] }
      return
    }
    const s = await stat(f)
    if (s.mtimeMs === state.configMtime && state.config) return
    state.config = parseModsConfig(await readFile(f, 'utf8'))
    state.configMtime = s.mtimeMs
  }

  const init = () =>
    (state.ready ||= (async () => {
      await mkdir(dataDir, { recursive: true })
      await loadSettings()
      await rescan()
      // Rules load from cache immediately; network refresh in background.
      rules.ensure({ major: state.game?.major, maxAgeHours: state.settings.dbMaxAgeHours }).catch((e) => log('rules ensure failed: ' + e.message))
    })())

  // ---- mod versions: update history, snapshots, git ----
  const historyPath = path.join(dataDir, 'modHistory.json')
  let history = null // { versions: {key: stamp}, events: [{time, key, name, source, from, to}] }
  const loadHistory = async () => {
    if (history) return history
    try {
      history = JSON.parse(await readFile(historyPath, 'utf8'))
    } catch {
      history = { versions: {}, events: [] }
    }
    return history
  }
  const saveHistory = async () => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(historyPath + '.tmp', JSON.stringify(history))
    await rename(historyPath + '.tmp', historyPath)
  }
  /** Version stamp of what's on disk: workshop timeupdated, git HEAD, else About.xml mtime. */
  const versionOf = (m) => {
    if (m.source === 'workshop' && m.publishedFileId) {
      const w = state.workshop?.items?.get(m.publishedFileId)
      if (w?.installed) return String(w.installed)
    }
    if (m.git?.head) return 'git-' + m.git.head
    return String(Math.floor((m.mtime || 0) / 1000))
  }
  const trackVersions = async () => {
    await loadHistory()
    const first = !Object.keys(history.versions).length
    const now = Date.now()
    // git info for local mods (only folders that contain .git)
    await Promise.all(state.mods.filter((m) => m.source === 'local').map(async (m) => { m.git = await gitInfo(m.path) }))
    let changed = false
    for (const m of state.mods) {
      if (m.kind !== 'mod') continue
      const v = versionOf(m)
      const prev = history.versions[m.key]
      if (prev !== v) {
        if (prev && !first) history.events.push({ time: now, key: m.key, name: m.name, source: m.source, publishedFileId: m.publishedFileId || null, from: prev, to: v })
        history.versions[m.key] = v
        changed = true
      }
    }
    if (history.events.length > 2000) history.events = history.events.slice(-2000)
    if (changed) await saveHistory()
    if (state.settings.modBackup?.auto) autoBackup().catch((e) => log('auto backup: ' + e.message))
  }
  let autoBackupRunning = false
  const autoBackup = async () => {
    if (autoBackupRunning) return
    autoBackupRunning = true
    try {
      const mb = state.settings.modBackup || {}
      const keys = mb.onlyActive !== false ? activeKeys() : state.mods.map((m) => m.key)
      for (const k of keys) {
        const m = state.catalog.get(k)
        if (!m || m.kind !== 'mod' || m.source !== 'workshop') continue
        await modBackups.backup(m, { version: versionOf(m), reason: 'auto', keep: mb.keep || 3 })
      }
    } finally {
      autoBackupRunning = false
    }
  }
  const updateInfo = (m) => {
    const w = m.publishedFileId ? state.workshop?.items?.get(m.publishedFileId) : null
    return {
      version: versionOf(m),
      installedAt: w?.installed ? w.installed * 1000 : m.mtime || null,
      latestAt: w?.latest ? w.latest * 1000 : null,
      needsUpdate: !!w?.needsUpdate,
      git: m.git || null,
      restored: /_rimlist_[\w.-]+$/.test(m.folder || ''),
    }
  }

  const classifyOne = async (packageId, { force = false, ai = null } = {}) => {
    await init()
    const m = state.catalog.get(pid(packageId))
    if (!m) return null
    const key = m.key
    if (ai) {
      const result = finalize({ ...ai, mod_name: m.name, package_id: m.packageId, author: m.author || '', supported_versions: m.supportedVersions || [], source: 'ai', updatedAt: Date.now() })
      await modTags.setAi(key, result)
      m.tags = result
      return result
    }
    const version = versionOf(m)
    const saved = !force ? await modTags.getAuto(key, version) : null
    const result = saved?.result || classifyMod(m, await inspectModFolder(m.path, state.game?.major), {
      dependents: state.mods.reduce((n, x) => n + (x.modDependencies || []).filter((d) => pid(d.packageId) === key).length, 0),
    })
    if (!saved) {
      const f = await inspectModFolder(m.path, state.game?.major)
      const automatic = classifyMod(m, f, { dependents: state.mods.reduce((n, x) => n + (x.modDependencies || []).filter((d) => pid(d.packageId) === key).length, 0) })
      await modTags.setAuto(key, version, automatic, signalsSummary(f))
      m.tags = automatic
    } else m.tags = saved.result
    const override = await modTags.getAi(key)
    if (override) m.tags = override
    return m.tags
  }
  const classifyAll = async ({ force = false, activeOnly = false } = {}) => {
    await init()
    const keys = state.mods.filter((m) => m.kind === 'mod' && (!activeOnly || activeKeys().includes(m.key))).map((m) => m.key)
    const out = []
    for (const key of keys) out.push(await classifyOne(key, { force }))
    await modTags.flush()
    return out
  }

  // ---- views ----
  const modView = (m) => ({
    key: m.key,
    packageId: m.packageId,
    name: m.name,
    author: m.author,
    kind: m.kind,
    source: m.source,
    path: m.path,
    publishedFileId: m.publishedFileId,
    steamAppId: m.steamAppId,
    url: m.url,
    supportedVersions: m.supportedVersions,
    modVersion: m.modVersion,
    hasPreview: !!m.preview,
    invalid: m.invalid,
    dependsOn: m.modDependencies.map((d) => ({ packageId: pid(d.packageId), name: d.displayName, url: d.steamWorkshopUrl || d.downloadUrl })),
    loadAfter: m.loadAfter.map(pid),
    loadBefore: m.loadBefore.map(pid),
    forceLoadAfter: m.forceLoadAfter.map(pid),
    forceLoadBefore: m.forceLoadBefore.map(pid),
    incompatibleWith: m.incompatibleWith.map(pid),
    nvw: rules.nvwCovers(m.key),
    rules: rules.rulesFor(m.key),
    replacement: rules.replacementFor({ publishedFileId: m.publishedFileId, packageId: m.key }) || null,
    update: updateInfo(m),
    tags: m.tags || null,
  })
  const activeKeys = () => (state.config?.activeMods || []).map(pid)

  const snapshot = async () => {
    await init()
    await loadConfig()
    const active = activeKeys()
    const diag = diagnose(active, state.catalog, rules, { gameMajor: state.game?.major, duplicates: state.duplicates })
    return {
      game: state.game,
      paths: effectivePaths(),
      discovered: state.discovered,
      settings: publicSettings(),
      dataDir, // Expose data directory location (read-only)
      scannedAt: state.scannedAt,
      modsConfigPath: modsConfigPath(),
      active,
      mods: state.mods.map(modView),
      diagnostics: diag,
      lists: await lists.summaries(),
      rules: await rules.status(),
    }
  }

  // ---- mutations on the active list ----
  const setActive = async (ids, { save = true } = {}) =>
    serialize(async () => {
      await init()
      const seen = new Set()
      const next = []
      for (const id of ids) {
        const k = pid(id)
        if (!k || seen.has(k)) continue
        seen.add(k)
        const m = state.catalog.get(k)
        next.push(m ? m.packageId : id)
      }
      state.config = { ...state.config, activeMods: next }
      if (save) await writeConfig()
      return { active: next.map(pid) }
    })

  const BACKUP_DIR = 'backups'
  const writeConfig = async () => {
    const f = modsConfigPath()
    if (!f) throw new Error('RimWorld config directory not found; set configDir in settings')
    const cfg = state.config
    const exp = new Set(cfg.knownExpansions.map(pid))
    for (const k of cfg.activeMods.map(pid)) if (/^ludeon\.rimworld\./.test(k)) exp.add(k)
    // RimWorld compares ModsConfig ids case-sensitively against its lowercased packageIds:
    // writing "Ludeon.RimWorld" makes the game show a greyed duplicate in BOTH lists. Always lowercase.
    const seen = new Set()
    const ids = cfg.activeMods.map(pid).filter((k) => k && !seen.has(k) && seen.add(k))
    const xml = buildModsConfig({ version: cfg.version || state.game?.full || '', activeMods: ids, knownExpansions: [...exp] })
    // Backup first.
    const bdir = path.join(dataDir, BACKUP_DIR)
    await mkdir(bdir, { recursive: true })
    if (await exists(f)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await copyFile(f, path.join(bdir, `ModsConfig.${stamp}.xml`))
      await pruneBackups(bdir)
    }
    await writeFile(f + '.tmp', xml, 'utf8')
    await rename(f + '.tmp', f)
    state.configMtime = (await stat(f)).mtimeMs
  }
  const pruneBackups = async (bdir) => {
    const files = (await readdir(bdir)).filter((n) => n.startsWith('ModsConfig.') && n.endsWith('.xml')).sort()
    const keep = Math.max(1, state.settings.backupKeep || 20)
    for (const n of files.slice(0, Math.max(0, files.length - keep))) await unlink(path.join(bdir, n)).catch(() => {})
  }
  const listBackups = async () => {
    const bdir = path.join(dataDir, BACKUP_DIR)
    try {
      const files = (await readdir(bdir)).filter((n) => n.startsWith('ModsConfig.') && n.endsWith('.xml')).sort().reverse()
      const out = []
      for (const n of files) {
        const s = await stat(path.join(bdir, n))
        out.push({ name: n, size: s.size, mtime: s.mtimeMs })
      }
      return out
    } catch {
      return []
    }
  }
  const restoreBackup = (name) =>
    serialize(async () => {
      if (!/^ModsConfig\.[\w-]+\.xml$/.test(name)) throw new Error('bad backup name')
      const text = await readFile(path.join(dataDir, BACKUP_DIR, name), 'utf8')
      const cfg = parseModsConfig(text)
      state.config = cfg
      await writeConfig()
      return { active: cfg.activeMods.map(pid) }
    })

  const sort = async ({ save = false, tieBreak } = {}) =>
    serialize(async () => {
      await init()
      const active = activeKeys()
      const r = sortLoadOrder(active, state.catalog, rules, { tieBreak: tieBreak ?? state.settings.sortTieBreak })
      const before = diagnose(active, state.catalog, rules, { gameMajor: state.game?.major }).counts
      const after = diagnose(r.order, state.catalog, rules, { gameMajor: state.game?.major }).counts
      if (save) {
        state.config = { ...state.config, activeMods: r.order.map((k) => state.catalog.get(k)?.packageId || k) }
        await writeConfig()
      }
      return { order: r.order, moved: r.moved, broken: r.broken, crossTierViolations: r.crossTierViolations, before, after, saved: !!save }
    })

  const explain = async (packageId) => {
    await init()
    const k = pid(packageId)
    const active = activeKeys()
    const { edges } = buildGraph(active, state.catalog, rules)
    const nameOf = (x) => state.catalog.get(x)?.name || x
    const before = []
    const after = []
    for (const e of edges.values()) {
      if (e.from === k) before.push({ target: e.to, name: nameOf(e.to), source: e.source, comment: e.comment })
      if (e.to === k) after.push({ target: e.from, name: nameOf(e.from), source: e.source, comment: e.comment })
    }
    const mod = state.catalog.get(k)
    return { packageId: k, name: nameOf(k), position: active.indexOf(k), mustLoadBefore: before, mustLoadAfter: after, rules: rules.rulesFor(k), installed: !!mod }
  }

  // ---- lists ----
  /** Where a mod came from, so another player (or a reinstall) can get it again. */
  const originOf = (m, fallback = {}) => {
    if (!m) return { source: fallback.source, git: fallback.git }
    const git = cleanGit(m.git?.remote ? { url: m.git.remote, branch: m.git.branch } : null)
    if (git) return { source: 'git', git }
    if (m.source === 'workshop' || m.publishedFileId) return { source: m.source === 'official' ? 'official' : 'workshop' }
    return { source: m.source }
  }
  /**
   * Install the mods of a list that are not on disk: git mods are cloned into the local Mods folder,
   * workshop mods open their Steam page (Steam has no API to subscribe for you). Nothing is activated —
   * apply the list again afterwards.
   */
  const installMissing = async ({ id, git = true, steam = true } = {}) => {
    await init()
    const l = await lists.get(id)
    if (!l) throw new Error('list not found: ' + id)
    const missing = l.mods.filter((m) => !state.catalog.has(pid(m.packageId)))
    const out = { cloned: [], opened: [], failed: [], manual: [] }
    let delay = 0
    for (const m of missing) {
      const name = m.name || m.packageId
      if (m.git?.url && git) {
        try {
          const r = await methods.gitInstall({ url: m.git.url, branch: m.git.branch })
          if (r.packageId && r.packageId !== pid(m.packageId)) out.failed.push({ packageId: m.packageId, name, error: `cloned ${r.path} but it is ${r.packageId}` })
          else out.cloned.push({ packageId: m.packageId, name, path: r.path, warning: r.warning })
        } catch (e) {
          out.failed.push({ packageId: m.packageId, name, url: m.git.url, error: String(e.message || e) })
        }
      } else if (m.publishedFileId && steam) {
        try {
          await new Promise((r) => setTimeout(r, delay))
          delay = 400
          await openWorkshopPage(m.publishedFileId, { browser: state.settings.workshopOpen === 'browser' })
          out.opened.push({ packageId: m.packageId, name, publishedFileId: m.publishedFileId })
        } catch (e) {
          out.failed.push({ packageId: m.packageId, name, error: String(e.message || e) })
        }
      } else out.manual.push({ packageId: m.packageId, name })
    }
    return { list: { id: l.id, name: l.name }, missing: missing.length, ...out }
  }
  const saveList = async (args) =>
    serialize(async () => {
      await init()
      const ids = Array.isArray(args.mods) ? args.mods : activeKeys()
      const mods = ids.map((x) => {
        const k = pid(typeof x === 'string' ? x : x.packageId)
        const m = state.catalog.get(k)
        return { packageId: m?.packageId || (typeof x === 'string' ? x : x.packageId), name: m?.name || x.name, publishedFileId: m?.publishedFileId || x.publishedFileId, version: m?.modVersion || undefined, ...originOf(m, x) }
      })
      return lists.save({ ...args, mods, gameVersion: args.gameVersion || state.game?.major || null, author: args.author ?? state.settings.authorName })
    })
  const applyList = async (id, { mode = 'replace' } = {}) =>
    serialize(async () => {
      await init()
      const l = await lists.get(id)
      if (!l) throw new Error('list not found: ' + id)
      const ids = l.mods.map((m) => m.packageId)
      const missing = ids.filter((x) => !state.catalog.has(pid(x)))
      let next = ids
      if (mode === 'merge') {
        const cur = state.config.activeMods
        const set = new Set(cur.map(pid))
        next = [...cur, ...ids.filter((x) => !set.has(pid(x)))]
      }
      state.config = { ...state.config, activeMods: next.filter((x) => state.catalog.has(pid(x))) }
      await writeConfig()
      return { active: activeKeys(), missing: missing.map((x) => ({ packageId: x, ...(l.mods.find((m) => m.packageId === x) || {}) })) }
    })
  const importText = async ({ text, name, save = true, author, url }) => {
    await init()
    const parsed = lists.parseText(text)
    return importParsed(parsed, { name, save, author, source: url ? { kind: 'url', url } : { kind: 'paste' } })
  }
  /** Resolve parsed mods against the catalog, diff vs the current load order, optionally save as a list. */
  const importParsed = async (parsed, { name, save = true, author, source }) => {
    const mods = lists.resolveMods(parsed.mods, state.catalog, rules)
    const current = activeKeys()
    const d = lists.diff(current, mods.filter((m) => !m.unresolved).map((m) => m.packageId))
    const result = {
      name: name || parsed.name || 'Imported list',
      description: parsed.description || '',
      author: author || parsed.author || '',
      gameVersion: parsed.gameVersion || null,
      mods,
      missing: mods.filter((m) => !m.installed),
      unresolved: mods.filter((m) => m.unresolved),
      diff: d,
    }
    if (save) {
      const saved = await lists.save({ name: result.name, description: result.description, author: result.author, gameVersion: result.gameVersion, mods: mods.map(({ installed, unresolved, ...m }) => m), source })
      result.list = saved
    }
    return result
  }
  // ---- save files (*.rws) ----
  const saveDetail = async ({ name }) => {
    await init()
    const s = await saves.get(effectivePaths().savesDir, name)
    const mods = lists.resolveMods(s.mods, state.catalog, rules)
    const d = lists.diff(activeKeys(), mods.map((m) => m.packageId))
    const { path: _p, ...rest } = s
    return { ...rest, mods, missing: mods.filter((m) => !m.installed), diff: d, sameAsCurrent: !d.added.length && !d.removed.length && !d.reordered.length }
  }
  const importSave = async ({ name, listName, save = true }) => {
    await init()
    const s = await saves.get(effectivePaths().savesDir, name)
    const major = s.gameVersion?.match(/\d+\.\d+/)?.[0] || null
    return importParsed(
      { name: listName || 'Save: ' + s.base.replace(/##/g, ' / '), description: `From save ${s.name} (${new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')}, RimWorld ${s.gameVersion || '?'})`, gameVersion: major, mods: s.mods },
      { save, source: { kind: 'save', file: s.name } },
    )
  }
  const importUrl = async ({ url, name, save = true }) => {
    const f = fetchImpl || globalThis.fetch
    let u = String(url || '').trim()
    // Normalise common hosts to raw text.
    u = u.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/')
    if (/^https:\/\/rentry\.(co|org)\/[\w-]+$/.test(u)) u += '/raw'
    if (/^https:\/\/gist\.github\.com\//.test(u) && !/\/raw/.test(u)) u += '/raw'
    if (/pastebin\.com\/(?!raw)/.test(u)) u = u.replace('pastebin.com/', 'pastebin.com/raw/')
    const res = await f(u, { headers: { 'user-agent': 'dsh-rimlist' } })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + u)
    const text = await res.text()
    return importText({ text, name, save, url: String(url) })
  }
  const exportList = async ({ id, format = 'rimlist' }) => {
    await init()
    const l = id ? await lists.get(id) : null
    const list = l || (await saveListVirtual())
    return { format, text: lists.toText(list, format, { gameVersionFull: state.game?.full }), name: list.name, filename: `${list.name.replace(/[^\w.-]+/g, '_')}.${format === 'modsconfig' || format === 'rimsort' ? 'xml' : format === 'rimlist' ? 'json' : format === 'markdown' ? 'md' : 'txt'}` }
  }
  const saveListVirtual = async () => {
    const ids = activeKeys()
    return {
      id: 'current',
      name: 'Current load order',
      description: '',
      author: state.settings.authorName || '',
      gameVersion: state.game?.major || null,
      mods: ids.map((k) => {
        const m = state.catalog.get(k)
        return { packageId: m?.packageId || k, name: m?.name, publishedFileId: m?.publishedFileId }
      }),
    }
  }
  const compareList = async ({ id }) => {
    await init()
    const l = await lists.get(id)
    if (!l) throw new Error('list not found: ' + id)
    const target = l.mods.map((m) => m.packageId)
    const d = lists.diff(activeKeys(), target)
    const nameOf = (k) => state.catalog.get(k)?.name || l.mods.find((m) => pid(m.packageId) === k)?.name || rules.steamByPid(k)?.name || k
    const decorate = (arr) => arr.map((k) => ({ packageId: k, name: nameOf(k), installed: state.catalog.has(k), publishedFileId: state.catalog.get(k)?.publishedFileId || l.mods.find((m) => pid(m.packageId) === k)?.publishedFileId || rules.steamByPid(k)?.pfid || null }))
    return { list: { id: l.id, name: l.name }, added: decorate(d.added), removed: decorate(d.removed), reordered: decorate(d.reordered), same: d.same, total: d.total }
  }

  // ---- dispatch for HTTP + tools ----
  const methods = {
    snapshot: () => snapshot(),
    rescan: async () => {
      await init()
      return serialize(rescan)
    },
    setActive: ({ ids }) => setActive(ids),
    activate: async ({ ids, position }) => {
      await init()
      const cur = activeKeys()
      const add = (Array.isArray(ids) ? ids : [ids]).map(pid).filter((k) => state.catalog.has(k) && !cur.includes(k))
      const next = [...cur]
      if (typeof position === 'number' && position >= 0 && position <= next.length) next.splice(position, 0, ...add)
      else next.push(...add)
      return setActive(next)
    },
    deactivate: async ({ ids }) => {
      await init()
      const rm = new Set((Array.isArray(ids) ? ids : [ids]).map(pid))
      return setActive(activeKeys().filter((k) => !rm.has(k)))
    },
    move: async ({ id, to }) => {
      await init()
      const cur = activeKeys()
      const i = cur.indexOf(pid(id))
      if (i < 0) throw new Error('not active: ' + id)
      const next = [...cur]
      next.splice(i, 1)
      next.splice(Math.max(0, Math.min(next.length, to)), 0, pid(id))
      return setActive(next)
    },
    sort: ({ save, tieBreak }) => sort({ save, tieBreak }),
    sortIds: async ({ ids, tieBreak }) => {
      await init()
      const keys = (Array.isArray(ids) ? ids : activeKeys()).map(pid)
      const r = sortLoadOrder(keys, state.catalog, rules, { tieBreak: tieBreak ?? state.settings.sortTieBreak })
      const before = diagnose(keys, state.catalog, rules, { gameMajor: state.game?.major }).counts
      const after = diagnose(r.order, state.catalog, rules, { gameMajor: state.game?.major }).counts
      return { order: r.order, moved: r.moved, broken: r.broken, crossTierViolations: r.crossTierViolations, before, after, saved: false }
    },
    diagnose: async ({ ids } = {}) => {
      await init()
      const keys = Array.isArray(ids) ? ids.map(pid) : activeKeys()
      return diagnose(keys, state.catalog, rules, { gameMajor: state.game?.major, duplicates: state.duplicates })
    },
    explain: ({ packageId }) => explain(packageId),
    mod: async ({ packageId }) => {
      await init()
      const m = state.catalog.get(pid(packageId))
      if (!m) return null
      const note = await modNotes.get(m.key)
      return { ...modView(m), description: m.description, note, steam: m.publishedFileId ? rules.steamByPfid(m.publishedFileId) : rules.steamByPid(m.key) }
    },
    classify: async ({ packageId, force = false } = {}) => classifyOne(packageId, { force }),
    classifyAll: async ({ force = false, activeOnly = false } = {}) => ({ tags: await classifyAll({ force, activeOnly }) }),
    classifySaveAi: async ({ packageId, result }) => classifyOne(packageId, { ai: result }),
    /** { key: display tags } for every installed mod (cached by version; first call scans folders). */
    tagIndex: async ({ force = false } = {}) => {
      const all = await classifyAll({ force })
      const tags = {}
      for (const r of all) if (r) tags[pid(r.package_id)] = { tags: r.display_tags_zh || [], type: r.primary_type, source: r.source }
      return { tags }
    },
    /** User edit of a mod's display tags (stored like an AI override). tags=null/[] with reset=true goes back to automatic. */
    setTags: async ({ packageId, tags, reset = false } = {}) => {
      await init()
      const m = state.catalog.get(pid(packageId))
      if (!m) throw new Error('mod not installed: ' + packageId)
      if (reset) {
        await modTags.clearAi(m.key)
        m.tags = null
        return classifyOne(m.key, {})
      }
      const list = [...new Set((Array.isArray(tags) ? tags : String(tags || '').split(/[,，、]/)).map((x) => String(x).trim()).filter(Boolean))].slice(0, 10)
      if (!list.length) throw new Error('tags is empty (use reset=true to go back to automatic tags)')
      const base = m.tags || (await classifyOne(m.key, {}))
      const result = finalize({ ...base, display_tags_zh: list, mod_name: m.name, package_id: m.packageId, author: m.author || '', supported_versions: m.supportedVersions || [], source: 'user', confidence: 1, updatedAt: Date.now() })
      await modTags.setAi(m.key, result)
      m.tags = result
      return result
    },
    /**
     * Batch of mods for an AI to review their tags: current tags + description + folder signals.
     * filter: all | auto (not yet reviewed) | low (confidence < maxConfidence) | reviewed (ai/user)
     */
    tagReview: async ({ activeOnly = true, filter = 'auto', maxConfidence = 0.7, offset = 0, limit = 20, tag, packageIds } = {}) => {
      await init()
      const act = new Set(activeKeys())
      let mods = packageIds?.length
        ? packageIds.map((x) => state.catalog.get(pid(x))).filter(Boolean)
        : state.mods.filter((m) => m.kind === 'mod' && (!activeOnly || act.has(m.key)))
      const rows = []
      for (const m of mods) {
        const tg = m.tags || (await classifyOne(m.key, {}))
        if (!tg) continue
        if (!packageIds?.length) {
          if (filter === 'auto' && tg.source !== 'auto') continue
          if (filter === 'reviewed' && tg.source === 'auto') continue
          if (filter === 'low' && !(tg.confidence < maxConfidence)) continue
          if (tag && !(tg.display_tags_zh || []).includes(tag) && !(tg.feature_tags || []).includes(tag)) continue
        }
        rows.push({ m, tg })
      }
      await modTags.flush()
      const page = rows.slice(offset, offset + Math.min(50, Math.max(1, limit)))
      const all = await modTags.all()
      const notes = await modNotes.all()
      return {
        total: rows.length,
        offset,
        next: offset + page.length < rows.length ? offset + page.length : null,
        mods: page.map(({ m, tg }) => ({
          packageId: m.packageId,
          name: m.name,
          author: m.author || '',
          active: act.has(m.key),
          tags: tg.display_tags_zh,
          primary_type: tg.primary_type,
          secondary_types: tg.secondary_types,
          feature_tags: tg.feature_tags,
          confidence: tg.confidence,
          source: tg.source,
          description: String(m.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500),
          signals: all.auto[m.key]?.signals || null,
          note: notes[m.key] || '',
        })),
      }
    },
    /** Reset tags to automatic: all mods (default) or the given packageIds; source='user'|'ai' limits which overrides go. */
    resetAllTags: async ({ packageIds, source } = {}) => {
      await init()
      const d = await modTags.all()
      let keys = packageIds?.length ? packageIds.map(pid) : Object.keys(d.ai)
      if (source) keys = keys.filter((k) => d.ai[k]?.source === source)
      const removed = await modTags.clearAllAi(keys)
      for (const k of keys) {
        const m = state.catalog.get(k)
        if (m) m.tags = null
      }
      return { removed }
    },
    /** Get note for a mod. */
    getNote: async ({ packageId }) => {
      await init()
      const m = state.catalog.get(pid(packageId))
      if (!m) return { note: '' }
      const note = await modNotes.get(m.key)
      return { note }
    },
    /** Set note for a mod (empty string removes it). */
    setNote: async ({ packageId, note }) => {
      await init()
      const m = state.catalog.get(pid(packageId))
      if (!m) throw new Error('mod not installed: ' + packageId)
      await modNotes.set(m.key, note || '')
      return { note: await modNotes.get(m.key) }
    },
    /** Get all notes (for AI tools). */
    getAllNotes: async () => {
      await init()
      const notes = await modNotes.all()
      const result = {}
      for (const [key, note] of Object.entries(notes)) {
        const m = state.catalog.get(key)
        if (m) result[m.packageId] = { name: m.name, note }
      }
      return { notes: result }
    },
    search: async ({ query, active, limit = 50, type, primaryOnly = false, tags, minConfidence } = {}) => {
      await init()
      const q = String(query || '').toLowerCase()
      const act = new Set(activeKeys())
      const wantTags = (Array.isArray(tags) ? tags : tags ? [tags] : []).map((t) => String(t).toLowerCase()).filter(Boolean)
      const byTag = !!(type || wantTags.length || minConfidence != null)
      let list = state.mods.filter((m) => (active === undefined || act.has(m.key) === !!active) && (!q || m.name.toLowerCase().includes(q) || m.key.includes(q) || (m.author || '').toLowerCase().includes(q) || m.publishedFileId === q))
      if (byTag) {
        list = list.filter((m) => m.kind === 'mod')
        const keep = []
        for (const m of list) {
          const t = m.tags || (await classifyOne(m.key, {}))
          if (!t) continue
          if (type && !(t.primary_type === type || (!primaryOnly && (t.secondary_types || []).includes(type)))) continue
          if (minConfidence != null && !(t.confidence >= minConfidence)) continue
          const have = new Set([...(t.feature_tags || []), ...(t.display_tags_zh || [])].map((x) => String(x).toLowerCase()))
          if (!wantTags.every((w) => have.has(w))) continue
          keep.push(m)
        }
        await modTags.flush()
        list = keep
      }
      return list.slice(0, limit).map((m) => ({
        key: m.key, name: m.name, author: m.author, active: act.has(m.key), publishedFileId: m.publishedFileId, supportedVersions: m.supportedVersions,
        ...(byTag && m.tags ? { primaryType: m.tags.primary_type, secondaryTypes: m.tags.secondary_types, tags: m.tags.display_tags_zh, confidence: m.tags.confidence } : {}),
      }))
    },
    // rules
    rulesStatus: async () => {
      await init()
      return rules.status()
    },
    refreshRules: async ({ force = true, key } = {}) => {
      await init()
      if (key) {
        await rules.refresh(key, state.game?.major)
        return rules.status()
      }
      return rules.ensure({ major: state.game?.major, maxAgeHours: force ? -1 : state.settings.dbMaxAgeHours, force })
    },
    /** Change where a database comes from: { key, mode: none|github|url|local, url?, path? }. Re-fetches immediately. */
    configureDatabase: ({ key, mode, url, path: filePath }) =>
      serialize(async () => {
        await init()
        if (!DB_KEYS.includes(key)) throw new Error('unknown database: ' + key)
        state.settings.databases = { ...state.settings.databases, [key]: { ...state.settings.databases[key], ...(mode ? { mode } : {}), ...(url !== undefined ? { url } : {}), ...(filePath !== undefined ? { path: filePath } : {}) } }
        applyDbConfig()
        await saveSettings()
        let error = null
        try {
          await rules.refresh(key, state.game?.major)
        } catch (e) {
          error = String(e.message || e)
        }
        const st = await rules.status()
        return { config: state.settings.databases[key], status: st[key], error: error || st[key].error || null }
      }),
    rimsortPaths: async () => {
      // Help the user point "local file" at an existing RimSort install.
      const home = homedir()
      const candidates = process.platform === 'win32' ? [path.join(process.env.APPDATA || '', 'RimSort')] : process.platform === 'darwin' ? [path.join(home, 'Library/Application Support/RimSort')] : [path.join(home, '.local/share/RimSort')]
      for (const base of candidates) {
        if (!(await exists(base))) continue
        const major = state.game?.major || '1.6'
        const files = {
          community: path.join(base, 'dbs/Community-Rules-Database/communityRules.json'),
          steam: path.join(base, 'dbs/Steam-Workshop-Database/steamDB.json'),
          noVersionWarning: path.join(base, 'dbs/NoVersionWarning', major, 'ModIdsToFix.xml'),
          useThisInstead: path.join(base, 'dbs/UseThisInstead/replacements.json.gz'),
          versions: path.join(base, 'dbs/rimworld-versions/rimworld_versions.json'),
          userRules: path.join(base, 'dbs/userRules.json'),
        }
        const out = { base }
        for (const [k, f] of Object.entries(files)) out[k] = (await exists(f)) ? f : null
        return out
      }
      return null
    },
    addRule: async (args) => {
      await init()
      await rules.addUserRule(args)
      return { rules: rules.rulesFor(args.packageId) }
    },
    removeRule: async (args) => {
      await init()
      await rules.removeUserRule(args)
      return { rules: rules.rulesFor(args.packageId) }
    },
    userRules: async () => {
      await init()
      return rules.userRules()
    },
    setUserRulesEnabled: async ({ enabled }) => {
      await init()
      state.settings.userRulesEnabled = !!enabled
      applyDbConfig()
      await saveSettings()
      return { enabled: !!enabled }
    },
    importUserRules: async ({ text, path: filePath, merge = true }) => {
      await init()
      const src = text || (filePath ? await readFile(filePath, 'utf8') : null)
      if (!src) throw new Error('text or path required')
      const count = await rules.importUserRules(JSON.parse(src), { merge })
      return { imported: count, total: Object.keys(rules.userRules()).length }
    },
    exportUserRules: async () => {
      await init()
      return { text: JSON.stringify(rules.exportUserRules(), null, 2), filename: 'userRules.json' }
    },
    /** Record the current relative order of the given active mods as user loadAfter rules (chain). */
    pinOrder: async ({ ids, comment, ordered }) => {
      await init()
      const keys = [...new Set((ids || []).map(pid).filter((k) => state.catalog.has(k)))]
      if (keys.length < 2) throw new Error('need at least two installed mods')
      // `ordered` = the caller already supplies the intended order (the UI's unsaved draft);
      // otherwise use the order currently saved in ModsConfig.xml.
      if (!ordered) {
        const cur = activeKeys()
        keys.sort((a, b) => cur.indexOf(a) - cur.indexOf(b))
      }
      for (let i = 1; i < keys.length; i++) await rules.addUserRule({ packageId: keys[i], kind: 'loadAfter', target: keys[i - 1], comment: comment || 'pinned order', name: state.catalog.get(keys[i - 1])?.name })
      return { chain: keys }
    },
    gameVersions: async () => {
      await init()
      return rules.gameVersions()
    },
    // lists
    lists: async () => {
      await init()
      return lists.summaries()
    },
    getList: async ({ id }) => {
      await init()
      return lists.get(id)
    },
    saveList,
    deleteList: async ({ id }) => {
      await init()
      return { ok: await lists.remove(id) }
    },
    applyList: ({ id, mode }) => applyList(id, { mode }),
    installMissing,
    compareList,
    importText,
    importUrl,
    exportList,
    // save files
    saves: async () => {
      await init()
      const dir = effectivePaths().savesDir
      return { dir, exists: !!dir && (await exists(dir)), saves: await saves.list(dir) }
    },
    saveDetail,
    importSave,
    backups: async () => {
      await init()
      return listBackups()
    },
    restoreBackup: ({ name }) => restoreBackup(name),
    // settings
    settings: async () => {
      await init()
      return publicSettings()
    },
    setSettings: async (patch) =>
      serialize(async () => {
        await init()
        patch = { ...patch }
        delete patch.steamcmd // removed feature; ignore from older clients
        const next = { ...state.settings, ...patch }
        if (patch.databases) next.databases = mergeDb({ ...state.settings.databases, ...patch.databases })
        if (patch.launch) next.launch = { ...DEFAULT_SETTINGS.launch, ...state.settings.launch, ...patch.launch }
        if (patch.rules) {
          // legacy boolean toggles from older clients
          delete next.rules
          for (const [k, v] of Object.entries(patch.rules)) {
            if (k === 'user') next.userRulesEnabled = !!v
            else if (DB_KEYS.includes(k)) next.databases[k] = { ...next.databases[k], mode: v ? (next.databases[k].mode === 'none' ? 'github' : next.databases[k].mode) : 'none' }
          }
        }
        state.settings = next
        applyDbConfig()
        await saveSettings()
        if (patch.databases || patch.rules) rules.ensure({ major: state.game?.major, maxAgeHours: state.settings.dbMaxAgeHours }).catch(() => {})
        if ('gameDir' in patch || 'configDir' in patch || 'workshopDir' in patch || 'localModsDir' in patch || 'extraModDirs' in patch) await rescan()
        return publicSettings()
      }),
    // game launch
    launchPreview: async (args = {}) => {
      await init()
      const cfg = { ...state.settings.launch, ...(args.launch || {}) }
      const dir = effectivePaths().gameDir
      let plan = null
      let error = null
      try {
        plan = await resolveLaunch(cfg, dir)
      } catch (e) {
        error = String(e.message || e)
      }
      return { platform: process.platform, config: cfg, detectedExecutable: await findGameExecutable(dir), command: plan ? [plan.cmd, ...plan.args].join(' ') : null, note: plan?.note, error }
    },
    /** quicktest=true adds -quicktest (skip the menu, generate a small test map) for a fast mod check. */
    launch: async ({ quicktest = false, extraArgs = [] } = {}) => {
      await init()
      await debugLog('launch', 'Called with quicktest:', quicktest, 'extraArgs:', extraArgs)
      await debugLog('launch', 'Settings:', state.settings.launch)
      await debugLog('launch', 'GameDir:', effectivePaths().gameDir)
      log('[launch] quicktest:', quicktest, 'extraArgs:', extraArgs)
      log('[launch] settings:', state.settings.launch)
      log('[launch] gameDir:', effectivePaths().gameDir)
      const extra = [...(quicktest ? ['-quicktest'] : []), ...(Array.isArray(extraArgs) ? extraArgs.map(String) : [])]
      try {
        const result = await launchGame(state.settings.launch, effectivePaths().gameDir, { extraArgs: extra })
        await debugLog('launch', 'Success:', result)
        log('[launch] result:', result)
        return result
      } catch (err) {
        await debugLog('launch', 'ERROR:', err.message, err.stack)
        log('[launch] ERROR:', err)
        throw err
      }
    },
    openSteamPage: async ({ publishedFileId, browser } = {}) => {
      await init()
      return openWorkshopPage(publishedFileId, { browser: browser ?? state.settings.workshopOpen === 'browser' })
    },
    subscribeMod: async ({ publishedFileId } = {}) => {
      await init()
      return { ...(await subscribeSteamWorkshop(publishedFileId)), method: 'steam-client' }
    },
    unsubscribeMod: async ({ publishedFileId } = {}) => {
      await init()
      return unsubscribeSteamWorkshop(publishedFileId)
    },
    gameStatus: async () => {
      await init()
      return gameStatus(effectivePaths().gameDir)
    },
    /** force=true: SIGKILL if the game ignores SIGTERM for waitMs. */
    stopGame: async ({ force = false, waitMs = 5000 } = {}) => {
      await init()
      return stopGame(effectivePaths().gameDir, { force: !!force, waitMs: Number(waitMs) || 0 })
    },
    // ---- mod updates / backups / git ----
    /** Recent updates: Steam's timeupdated for workshop mods + scan history for local/git mods; plus pending workshop updates. */
    modUpdates: async ({ days = 30, onlyActive = false } = {}) => {
      await init()
      await loadHistory()
      const since = Date.now() - days * 86400000
      const act = new Set(activeKeys())
      const want = (k) => !onlyActive || act.has(k)
      const recent = []
      for (const m of state.mods) {
        if (m.kind !== 'mod' || m.source !== 'workshop' || !want(m.key)) continue
        const u = updateInfo(m)
        if (u.installedAt && u.installedAt >= since) recent.push({ key: m.key, name: m.name, source: m.source, publishedFileId: m.publishedFileId, time: u.installedAt, active: act.has(m.key), needsUpdate: u.needsUpdate })
      }
      for (const e of history.events) if (e.time >= since && e.source !== 'workshop' && want(e.key)) recent.push({ ...e, active: act.has(e.key) })
      const pending = state.mods
        .filter((m) => m.kind === 'mod' && want(m.key) && updateInfo(m).needsUpdate)
        .map((m) => ({ key: m.key, name: m.name, publishedFileId: m.publishedFileId, latestAt: updateInfo(m).latestAt, active: act.has(m.key) }))
      const backupKeys = new Set((await modBackups.list()).map((b) => b.key))
      recent.sort((a, b) => b.time - a.time)
      for (const r of recent) r.hasBackup = backupKeys.has(r.key)
      return { recent, pending, scannedAt: state.scannedAt }
    },
    /** Update log of one mod: Steam changelog (workshop) or git commits (git mods). */
    modChangelog: async ({ packageId, force = false }) => {
      await init()
      const m = state.catalog.get(pid(packageId))
      if (!m) throw new Error('mod not found: ' + packageId)
      if (m.git) return { kind: 'git', entries: await gitRecentLog(m.path, 40), git: m.git }
      if (!m.publishedFileId) return { kind: 'none', entries: [] }
      const u = updateInfo(m)
      const c = await changelogs.get(m.publishedFileId, { force, needTime: u.latestAt ? Math.floor(u.latestAt / 1000) : 0 })
      const installed = u.installedAt ? Math.floor(u.installedAt / 1000) : 0
      return {
        kind: 'workshop',
        url: `https://steamcommunity.com/sharedfiles/filedetails/changelog/${m.publishedFileId}`,
        installed,
        entries: c.entries.slice(0, 60).map((e) => ({ ...e, current: Math.abs(e.time - installed) < 600, newer: e.time > installed + 600 })),
        fetchedAt: c.fetchedAt,
      }
    },
    modBackups: async ({ packageId } = {}) => {
      await init()
      const items = await modBackups.list(packageId ? pid(packageId) : undefined)
      return { items: items.map(({ dir, ...b }) => b), usage: await modBackups.usage() }
    },
    backupMod: async ({ packageId, ids, reason = 'manual' } = {}) => {
      await init()
      const keys = (ids && ids.length ? ids : [packageId]).filter(Boolean).map(pid)
      const out = []
      for (const k of keys) {
        const m = state.catalog.get(k)
        if (!m || m.kind !== 'mod') continue
        out.push(await modBackups.backup(m, { version: versionOf(m), reason, keep: state.settings.modBackup?.keep || 3 }))
      }
      return { backups: out }
    },
    deleteModBackup: async ({ id }) => {
      await modBackups.remove(id)
      return { removed: id }
    },
    /** Pin an old version: copy the snapshot into Mods/ (a local copy beats the workshop copy with the same packageId). */
    restoreModBackup: async ({ id }) =>
      serialize(async () => {
        await init()
        const r = await modBackups.restore(id, effectivePaths().localModsDir)
        await rescan()
        return { ...r, note: 'Installed into the local Mods folder; RimWorld loads it instead of the workshop copy. Remove it (RimList: 移除本地副本) to go back to the workshop version.' }
      }),
    /** Remove a mod folder that RimList itself installed (restored snapshot or git clone). A backup is taken first. */
    removeLocalMod: async ({ packageId }) =>
      serialize(async () => {
        await init()
        const m = state.catalog.get(pid(packageId))
        const base = effectivePaths().localModsDir
        if (!m || m.source !== 'local' || !base || path.resolve(path.dirname(m.path)) !== path.resolve(base)) throw new Error('only mods inside the local Mods folder can be removed')
        if (!(await exists(path.join(m.path, '.rimlist-restored.json'))) && !(await exists(path.join(m.path, '.rimlist-git.json')))) throw new Error('this folder was not installed by RimList; remove it by hand')
        await modBackups.backup(m, { version: versionOf(m), reason: 'before-remove', keep: state.settings.modBackup?.keep || 3 })
        await rm(m.path, { recursive: true, force: true })
        await rescan()
        return { removed: m.path }
      }),
    setModBackup: async (patch = {}) => {
      await init()
      const { auto, keep, onlyActive } = patch
      state.settings.modBackup = { ...DEFAULT_SETTINGS.modBackup, ...state.settings.modBackup, ...(auto === undefined ? {} : { auto: !!auto }), ...(keep === undefined ? {} : { keep: Math.max(1, Math.min(50, Number(keep) || 3)) }), ...(onlyActive === undefined ? {} : { onlyActive: !!onlyActive }) }
      await saveSettings()
      if (state.settings.modBackup.auto) autoBackup().catch(() => {})
      return state.settings.modBackup
    },
    // git
    gitInstall: async ({ url, branch, activate = false }) =>
      serialize(async () => {
        await init()
        const u = normalizeGitUrl(url)
        const base = effectivePaths().localModsDir
        if (!base) throw new Error('local Mods folder not found; set it in settings')
        await mkdir(base, { recursive: true })
        const dest = path.join(base, repoName(u))
        if (await exists(dest)) throw new Error('folder already exists: ' + dest)
        const args = ['clone', '--depth', '50']
        if (branch) {
          if (String(branch).startsWith('-')) throw new Error('invalid branch')
          args.push('--branch', String(branch))
        }
        args.push('--', u, dest)
        await runGit(args, { timeoutMs: 600000 })
        await writeFile(path.join(dest, '.rimlist-git.json'), JSON.stringify({ url: u, branch: branch || null, installedAt: Date.now() }, null, 2))
        await rescan()
        const m = state.mods.find((x) => path.resolve(x.path) === path.resolve(dest))
        if (!m) return { path: dest, warning: 'cloned, but no About/About.xml at the repo root (is it a RimWorld mod?)' }
        if (activate && !activeKeys().includes(m.key)) {
          state.config = { ...state.config, activeMods: [...state.config.activeMods, m.packageId] }
          await writeConfig()
        }
        return { path: dest, packageId: m.key, name: m.name, git: m.git, activated: !!activate }
      }),
    gitCheck: async ({ packageId } = {}) => {
      await init()
      const mods = packageId ? [state.catalog.get(pid(packageId))].filter(Boolean) : state.mods.filter((m) => m.git)
      const out = []
      for (const m of mods) {
        if (!m.git) continue
        try {
          out.push({ key: m.key, name: m.name, git: m.git, ...(await gitCheck(m.path)) })
        } catch (e) {
          out.push({ key: m.key, name: m.name, git: m.git, error: e.message })
        }
      }
      return { mods: out }
    },
    gitUpdate: async ({ packageId }) =>
      serialize(async () => {
        await init()
        const m = state.catalog.get(pid(packageId))
        if (!m?.git) throw new Error('not a git mod: ' + packageId)
        const before = m.git.head
        await modBackups.backup(m, { version: versionOf(m), reason: 'before-git-pull', keep: state.settings.modBackup?.keep || 3 })
        const r = await runGit(['pull', '--ff-only'], { cwd: m.path, timeoutMs: 600000 })
        await rescan()
        const after = state.catalog.get(m.key)?.git?.head
        return { key: m.key, name: m.name, from: before, to: after, changed: before !== after, output: r.stdout.split('\n').slice(-5).join('\n') }
      }),

    // ---- game log (Player.log) ----
    /** Cheap poll: path + size + mtime so the UI can auto-reload when the game writes a new log. */
    logInfo: async ({ previous = false } = {}) => {
      await init()
      const f = await findLogFile(effectivePaths().configDir, { previous })
      if (!f) return { path: null }
      const st = await stat(f)
      return { path: f, size: st.size, mtime: st.mtimeMs }
    },
    /** Parsed entries for the log viewer. */
    readLog: async ({ previous = false, maxEntries = 3000 } = {}) => {
      await init()
      const f = await findLogFile(effectivePaths().configDir, { previous })
      if (!f) return { path: null, entries: [] }
      const r = await readLogFile(f)
      const mods = activeKeys().map((k) => state.catalog.get(k)).filter(Boolean)
      const { entries, counts } = parseLog(r.text)
      const out = entries.slice(-maxEntries).map((e) => ({ line: e.line, level: e.level, pattern: e.pattern, trace: e.trace, count: counts.get(e.pattern), mods: e.level === 'info' ? [] : attributeMods(e, mods) }))
      const totals = { error: 0, warning: 0, info: 0 }
      for (const e of entries) totals[e.level]++
      return { path: f, size: r.size, mtime: r.mtime, truncated: r.truncated, totals, entries: out }
    },
    /** Compact LLM-ready summary (unique errors/warnings, counts, mod attribution). */
    logSummary: async ({ previous = false, level = 'warning', maxChars = 24000 } = {}) => {
      await init()
      const f = await findLogFile(effectivePaths().configDir, { previous })
      if (!f) return { path: null, text: 'Player.log not found (start the game once).' }
      const r = await readLogFile(f)
      const mods = activeKeys().map((k) => state.catalog.get(k)).filter(Boolean)
      const sum = summarize({ text: r.text, mods, level, maxChars })
      const nameOf = (k) => state.catalog.get(k)?.name || k
      return { path: f, mtime: r.mtime, totals: sum.totals, unique: sum.unique, modHits: sum.modHits.map(([k, n]) => ({ packageId: k, name: nameOf(k), errors: n })), text: summaryToText(sum, nameOf, f) }
    },
    previewPath: async ({ packageId }) => {
      await init()
      return state.catalog.get(pid(packageId))?.preview || null
    },
    // ---- debug log ----
    getDebugLog: async ({ lines = 100 } = {}) => {
      const logPath = path.join(dataDir, 'debug.log')
      if (!(await exists(logPath))) return { lines: [], path: logPath }
      const content = await readFile(logPath, 'utf-8')
      const allLines = content.split('\n').filter(l => l.trim())
      const recent = allLines.slice(-lines)
      return { lines: recent, path: logPath, total: allLines.length }
    },
    clearDebugLog: async () => {
      const logPath = path.join(dataDir, 'debug.log')
      if (await exists(logPath)) await unlink(logPath)
      return { cleared: true, path: logPath }
    },
  }

  const dispatch = async (method, args = {}) => {
    const fn = methods[method]
    if (!fn) throw new Error('unknown method: ' + method)
    return fn(args || {})
  }

  return { init, dispatch, state, rules, lists, activeKeys, effectivePaths }
}

/** Simple note store: { [packageId]: noteText } */
function createNoteStore({ dataDir, readJson, writeJson }) {
  const file = path.join(dataDir, 'modNotes.json')
  let data = null
  let dirty = false
  let timer = null
  const load = async () => {
    if (data) return data
    data = await readJson(file).catch(() => ({}))
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
    async get(key) {
      return (await load())[key] || ''
    },
    async set(key, note) {
      const d = await load()
      if (!note || note.trim() === '') delete d[key]
      else d[key] = note.trim()
      later()
    },
    async all() {
      return await load()
    },
    flush,
  }
}
