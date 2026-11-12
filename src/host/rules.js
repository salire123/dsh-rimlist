/**
 * Rule databases, RimSort-compatible source configuration.
 *
 * Each database has a mode:
 *   none    – not used
 *   github  – fetch the canonical raw file from the GitHub repo (default)
 *   url     – fetch an arbitrary URL (raw JSON/XML, .gz, or a repo .zip archive)
 *   local   – read a file on disk (e.g. RimSort's own ~/.local/share/RimSort/dbs/…)
 *
 * Databases:
 *   community        RimSort/Community-Rules-Database → communityRules.json
 *   steam            RimSort/Steam-Workshop-Database  → steamDB.json (slimmed before caching)
 *   noVersionWarning emipa606/NoVersionWarning        → <major>/ModIdsToFix.xml
 *   useThisInstead   emipa606/UseThisInstead          → replacements.json.gz
 *   versions         bukforks/rimworld-versions       → rimworld_versions.json
 *   user             <dataDir>/userRules.json (same shape as community rules; always wins)
 *
 * Remote data is cached under <dataDir>/db/ and refreshed on demand or when older
 * than `maxAgeHours`; failures keep the previous cache.
 */
import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises'
import path from 'node:path'
import { pid } from './xml.js'
import { gunzipText, isGzip, isZip, zipFind } from './archive.js'

export const DB_DEFS = {
  community: {
    label: 'Community Rules',
    repo: 'https://github.com/RimSort/Community-Rules-Database',
    raw: () => 'https://raw.githubusercontent.com/RimSort/Community-Rules-Database/main/communityRules.json',
    zip: 'https://github.com/RimSort/Community-Rules-Database/archive/refs/heads/main.zip',
    inZip: 'communityRules.json',
    cache: () => 'communityRules.json',
    rimsortLocal: 'dbs/Community-Rules-Database/communityRules.json',
  },
  steam: {
    label: 'Steam Workshop',
    repo: 'https://github.com/RimSort/Steam-Workshop-Database',
    raw: () => 'https://raw.githubusercontent.com/RimSort/Steam-Workshop-Database/main/steamDB.json',
    zip: 'https://github.com/RimSort/Steam-Workshop-Database/archive/refs/heads/main.zip',
    inZip: 'steamDB.json',
    cache: () => 'steamDB.slim.json',
    rimsortLocal: 'dbs/Steam-Workshop-Database/steamDB.json',
  },
  noVersionWarning: {
    label: 'No Version Warning',
    repo: 'https://github.com/emipa606/NoVersionWarning',
    raw: (major) => `https://raw.githubusercontent.com/emipa606/NoVersionWarning/main/${major}/ModIdsToFix.xml`,
    zip: 'https://github.com/emipa606/NoVersionWarning/archive/refs/heads/main.zip',
    inZip: (major) => `/${major}/ModIdsToFix.xml`,
    cache: (major) => `noVersionWarning-${major}.json`,
    rimsortLocal: (major) => `dbs/NoVersionWarning/${major}/ModIdsToFix.xml`,
  },
  useThisInstead: {
    label: 'Use This Instead',
    repo: 'https://github.com/emipa606/UseThisInstead',
    raw: () => 'https://raw.githubusercontent.com/emipa606/UseThisInstead/master/replacements.json.gz',
    zip: 'https://github.com/emipa606/UseThisInstead/archive/refs/heads/master.zip',
    inZip: 'replacements.json.gz',
    cache: () => 'useThisInstead.json',
    rimsortLocal: 'dbs/UseThisInstead/replacements.json.gz',
  },
  versions: {
    label: 'RimWorld Versions',
    repo: 'https://github.com/bukforks/rimworld-versions',
    raw: () => 'https://raw.githubusercontent.com/bukforks/rimworld-versions/main/rimworld_versions.json',
    zip: 'https://github.com/bukforks/rimworld-versions/archive/refs/heads/main.zip',
    inZip: 'rimworld_versions.json',
    cache: () => 'rimworldVersions.json',
    rimsortLocal: 'dbs/rimworld-versions/rimworld_versions.json',
  },
}
export const DB_KEYS = Object.keys(DB_DEFS)
export const DEFAULT_DB_CONFIG = Object.fromEntries(DB_KEYS.map((k) => [k, { mode: 'github', url: '', path: '' }]))

const EMPTY_RULES = { loadAfter: {}, loadBefore: {}, incompatibleWith: {}, ignoreIncompatible: {}, loadTop: null, loadBottom: null }

export function createRuleStore({ dataDir, log = () => {}, fetchImpl = globalThis.fetch }) {
  const dbDir = path.join(dataDir, 'db')
  const userRulesFile = path.join(dataDir, 'userRules.json')
  const state = {
    config: JSON.parse(JSON.stringify(DEFAULT_DB_CONFIG)),
    userEnabled: true,
    community: { rules: {}, timestamp: null, error: null },
    steam: { byPid: new Map(), byPfid: new Map(), version: null, error: null },
    noVersionWarning: { ids: new Set(), major: null, error: null },
    useThisInstead: { byOldPfid: new Map(), byOldPid: new Map(), version: null, count: 0, error: null },
    versions: { list: [], error: null },
    user: { rules: {}, loadedAt: null },
  }

  const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
  const writeJsonAtomic = async (file, value) => {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    await writeFile(tmp, JSON.stringify(value), 'utf8')
    await rename(tmp, file)
  }
  const ageHours = async (file) => {
    try {
      return (Date.now() - (await stat(file)).mtimeMs) / 36e5
    } catch {
      return Infinity
    }
  }
  const cachePath = (key, major) => path.join(dbDir, DB_DEFS[key].cache(major))
  const cfg = (key) => state.config[key] || { mode: 'github' }

  /** Fetch bytes from URL and unwrap .gz / .zip down to the wanted text. */
  const fetchText = async (url, inZip) => {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'dsh-rimlist' } })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url)
    const buf = Buffer.from(await res.arrayBuffer())
    return unwrap(buf, inZip, url)
  }
  const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  const unwrap = (buf, inZip, label) => {
    if (isZip(buf)) {
      const inner = zipFind(buf, inZip)
      if (!inner) throw new Error(`${inZip} not found inside ${label}`)
      return stripBom(isGzip(inner) ? gunzipText(inner) : inner.toString('utf8'))
    }
    if (isGzip(buf)) return stripBom(gunzipText(buf))
    return stripBom(buf.toString('utf8'))
  }
  /** Obtain raw text for a database according to its configured source. */
  const obtain = async (key, major) => {
    const def = DB_DEFS[key]
    const c = cfg(key)
    const inZip = typeof def.inZip === 'function' ? def.inZip(major) : def.inZip
    if (c.mode === 'local') {
      if (!c.path) throw new Error(def.label + ': local file path not set')
      return unwrap(await readFile(c.path), inZip, c.path)
    }
    if (c.mode === 'url') {
      if (!c.url) throw new Error(def.label + ': URL not set')
      return fetchText(c.url, inZip)
    }
    return fetchText(def.raw(major), inZip)
  }

  // ---- normalization ----
  const normalizeRules = (raw) => {
    const out = {}
    if (!raw || typeof raw !== 'object') return out
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue
      const r = { ...EMPTY_RULES, loadAfter: {}, loadBefore: {}, incompatibleWith: {}, ignoreIncompatible: {} }
      for (const field of ['loadAfter', 'loadBefore', 'incompatibleWith', 'ignoreIncompatible']) {
        const src = v[field]
        if (!src) continue
        if (Array.isArray(src)) for (const t of src) r[field][pid(t)] = { name: [] }
        else if (typeof src === 'object') for (const [t, info] of Object.entries(src)) r[field][pid(t)] = { name: Array.isArray(info?.name) ? info.name : info?.name ? [String(info.name)] : [], comment: info?.comment || undefined }
      }
      if (v.loadTop && (v.loadTop === true || v.loadTop.value)) r.loadTop = { comment: v.loadTop.comment || '' }
      if (v.loadBottom && (v.loadBottom === true || v.loadBottom.value)) r.loadBottom = { comment: v.loadBottom.comment || '' }
      out[pid(k)] = r
    }
    return out
  }
  const slimSteam = (raw) => {
    const db = raw && raw.database ? raw.database : {}
    const slim = {}
    for (const [pfid, e] of Object.entries(db)) {
      if (!e || typeof e !== 'object') continue
      const packageId = e.packageId || e.packageid
      slim[pfid] = {
        p: packageId ? pid(packageId) : undefined,
        n: e.name || e.steamName || undefined,
        a: e.authors || undefined,
        u: e.url || undefined,
        v: Array.isArray(e.gameVersions) ? e.gameVersions : undefined,
        d: e.dependencies && typeof e.dependencies === 'object' ? Object.fromEntries(Object.entries(e.dependencies).map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v)])) : undefined,
        x: e.unpublished ? 1 : undefined,
        app: e.appid ? 1 : undefined,
      }
    }
    return { version: raw.version || null, database: slim }
  }
  const indexSteam = (slim) => {
    const byPid = new Map()
    const byPfid = new Map()
    for (const [pfid, e] of Object.entries(slim.database || {})) {
      const entry = { pfid, packageId: e.p, name: e.n, authors: e.a, url: e.u, gameVersions: e.v || [], dependencies: e.d || {}, unpublished: !!e.x, isApp: !!e.app }
      byPfid.set(pfid, entry)
      if (e.p && !byPid.has(e.p)) byPid.set(e.p, entry)
    }
    state.steam.byPid = byPid
    state.steam.byPfid = byPfid
    state.steam.version = slim.version
  }
  const parseNvw = (xml) => {
    const ids = new Set()
    for (const m of String(xml).matchAll(/<li>\s*([^<\s]+)\s*<\/li>/g)) ids.add(pid(m[1]))
    return ids
  }
  const indexUti = (raw) => {
    const rules = Array.isArray(raw?.rules) ? raw.rules : Array.isArray(raw) ? raw : []
    const byOldPfid = new Map()
    const byOldPid = new Map()
    for (const r of rules) {
      const e = { oldPfid: String(r.oldWorkshopId || ''), oldName: r.oldName, oldPackageId: r.oldPackageId ? pid(r.oldPackageId) : '', newPfid: String(r.newWorkshopId || ''), newName: r.newName, newAuthor: r.newAuthor, newPackageId: r.newPackageId ? pid(r.newPackageId) : '', newVersions: r.newVersions || [] }
      if (e.oldPfid) byOldPfid.set(e.oldPfid, e)
      if (e.oldPackageId && !byOldPid.has(e.oldPackageId)) byOldPid.set(e.oldPackageId, e)
    }
    state.useThisInstead.byOldPfid = byOldPfid
    state.useThisInstead.byOldPid = byOldPid
    state.useThisInstead.version = raw?.version || null
    state.useThisInstead.count = rules.length
  }
  const indexVersions = (raw) => {
    const v = raw?.versions || {}
    const list = Array.isArray(v.linux) ? v.linux : Array.isArray(v.win64) ? v.win64 : Object.values(v)[0] || []
    state.versions.list = list.map((e) => ({ version: e.version, manifestId: e.manifest_id, status: e.status, dlcs: e.dlcs || {} }))
  }

  // ---- load cached ----
  const loaders = {
    community: async () => {
      const raw = await readJson(cachePath('community'))
      state.community.rules = normalizeRules(raw.rules)
      state.community.timestamp = raw.timestamp || null
    },
    steam: async () => indexSteam(await readJson(cachePath('steam'))),
    noVersionWarning: async (major) => {
      if (!major) return
      const raw = await readJson(cachePath('noVersionWarning', major))
      state.noVersionWarning.ids = new Set(raw.ids || [])
      state.noVersionWarning.major = major
    },
    useThisInstead: async () => indexUti(await readJson(cachePath('useThisInstead'))),
    versions: async () => indexVersions(await readJson(cachePath('versions'))),
  }
  const clear = {
    community: () => (state.community.rules = {}),
    steam: () => indexSteam({ database: {} }),
    noVersionWarning: () => (state.noVersionWarning.ids = new Set()),
    useThisInstead: () => indexUti({ rules: [] }),
    versions: () => indexVersions({}),
  }
  const loadCached = async (key, major) => {
    if (cfg(key).mode === 'none') {
      clear[key]()
      return
    }
    try {
      await loaders[key](major)
      state[key].error = null
    } catch (err) {
      if (err.code !== 'ENOENT') state[key].error = String(err.message || err)
    }
  }
  const loadUser = async () => {
    try {
      const raw = await readJson(userRulesFile)
      state.user.rules = normalizeRules(raw.rules || raw)
      state.user.loadedAt = Date.now()
    } catch (err) {
      if (err.code !== 'ENOENT') log('userRules.json unreadable: ' + err.message)
    }
  }

  // ---- refresh (obtain → validate → cache → load) ----
  const refreshers = {
    community: async () => {
      const raw = JSON.parse(await obtain('community'))
      if (!raw || typeof raw.rules !== 'object') throw new Error('communityRules.json has no rules')
      await writeJsonAtomic(cachePath('community'), raw)
    },
    steam: async () => {
      const raw = JSON.parse(await obtain('steam'))
      if (!raw || typeof raw.database !== 'object') throw new Error('steamDB.json has no database')
      await writeJsonAtomic(cachePath('steam'), slimSteam(raw))
    },
    noVersionWarning: async (major) => {
      if (!major) return
      const ids = [...parseNvw(await obtain('noVersionWarning', major))]
      if (!ids.length) throw new Error('ModIdsToFix.xml for ' + major + ' is empty')
      await writeJsonAtomic(cachePath('noVersionWarning', major), { ids, fetchedAt: Date.now() })
    },
    useThisInstead: async () => {
      const raw = JSON.parse(await obtain('useThisInstead'))
      const rules = Array.isArray(raw?.rules) ? raw.rules : Array.isArray(raw) ? raw : null
      if (!rules) throw new Error('replacements.json has no rules')
      await writeJsonAtomic(cachePath('useThisInstead'), { version: raw.version || null, rules })
    },
    versions: async () => {
      const raw = JSON.parse(await obtain('versions'))
      if (!raw || typeof raw.versions !== 'object') throw new Error('rimworld_versions.json has no versions')
      await writeJsonAtomic(cachePath('versions'), raw)
    },
  }
  const refresh = async (key, major) => {
    if (cfg(key).mode === 'none') {
      clear[key]()
      return
    }
    await refreshers[key](major)
    await loadCached(key, major)
  }

  /** Load caches from disk; (re)download anything missing or older than maxAgeHours. */
  const ensure = async ({ major, maxAgeHours = 24 * 7, force = false } = {}) => {
    await mkdir(dbDir, { recursive: true })
    await Promise.all([...DB_KEYS.map((k) => loadCached(k, major)), loadUser()])
    const jobs = []
    for (const key of DB_KEYS) {
      if (cfg(key).mode === 'none') continue
      if (key === 'noVersionWarning' && !major) continue
      // Local files are always re-read (cheap) so edits show up; remote by age.
      const need = cfg(key).mode === 'local' || force || (await ageHours(cachePath(key, major))) > maxAgeHours
      if (need) jobs.push(refresh(key, major).catch((e) => (state[key].error = String(e.message || e))))
    }
    await Promise.all(jobs)
    return status()
  }

  const status = async () => {
    const info = async (key, major) => {
      try {
        const s = await stat(cachePath(key, major))
        return { cached: true, fetchedAt: s.mtimeMs, size: s.size }
      } catch {
        return { cached: false }
      }
    }
    const base = async (key, major) => ({ ...(await info(key, major)), ...cfg(key), label: DB_DEFS[key].label, repo: DB_DEFS[key].repo, defaultUrl: DB_DEFS[key].zip, error: state[key].error, enabled: cfg(key).mode !== 'none' })
    const nvwMajor = state.noVersionWarning.major
    return {
      community: { ...(await base('community')), rules: Object.keys(state.community.rules).length, timestamp: state.community.timestamp },
      steam: { ...(await base('steam')), entries: state.steam.byPfid.size, version: state.steam.version },
      noVersionWarning: { ...(await base('noVersionWarning', nvwMajor)), ids: state.noVersionWarning.ids.size, major: nvwMajor },
      useThisInstead: { ...(await base('useThisInstead')), entries: state.useThisInstead.count, version: state.useThisInstead.version },
      versions: { ...(await base('versions')), entries: state.versions.list.length, latest: state.versions.list.at(-1)?.version || null },
      user: { rules: Object.keys(state.user.rules).length, file: userRulesFile, enabled: state.userEnabled },
    }
  }

  /** Replace the source config for one or more databases. Returns the new config. */
  const configure = (patch) => {
    for (const [key, v] of Object.entries(patch || {})) {
      if (!(key in DB_DEFS) || !v || typeof v !== 'object') continue
      const mode = ['none', 'github', 'url', 'local'].includes(v.mode) ? v.mode : state.config[key].mode
      state.config[key] = { mode, url: typeof v.url === 'string' ? v.url.trim() : state.config[key].url, path: typeof v.path === 'string' ? v.path.trim() : state.config[key].path }
    }
    return state.config
  }
  const getConfig = () => state.config

  // ---- user rules CRUD ----
  const saveUser = async () => {
    const plain = {}
    for (const [k, r] of Object.entries(state.user.rules)) {
      const o = {}
      for (const f of ['loadAfter', 'loadBefore', 'incompatibleWith', 'ignoreIncompatible']) if (Object.keys(r[f]).length) o[f] = r[f]
      if (r.loadTop) o.loadTop = { value: true, comment: r.loadTop.comment || '' }
      if (r.loadBottom) o.loadBottom = { value: true, comment: r.loadBottom.comment || '' }
      if (Object.keys(o).length) plain[k] = o
    }
    await writeJsonAtomic(userRulesFile, { timestamp: Date.now(), rules: plain })
    state.user.loadedAt = Date.now()
  }
  const addUserRule = async ({ packageId, kind, target, comment, name }) => {
    const k = pid(packageId)
    if (!k) throw new Error('packageId required')
    const r = state.user.rules[k] || (state.user.rules[k] = { loadAfter: {}, loadBefore: {}, incompatibleWith: {}, ignoreIncompatible: {}, loadTop: null, loadBottom: null })
    if (!r.ignoreIncompatible) r.ignoreIncompatible = {}
    if (kind === 'loadTop' || kind === 'loadBottom') {
      r[kind] = { comment: comment || '' }
      if (kind === 'loadTop') r.loadBottom = null
      else r.loadTop = null
    } else if (kind === 'loadAfter' || kind === 'loadBefore' || kind === 'incompatibleWith' || kind === 'ignoreIncompatible') {
      const t = pid(target)
      if (!t) throw new Error('target packageId required')
      if (t === k) throw new Error('a mod cannot reference itself')
      r[kind][t] = { name: name ? [name] : [], comment: comment || undefined }
      const opposite = kind === 'loadAfter' ? 'loadBefore' : kind === 'loadBefore' ? 'loadAfter' : kind === 'incompatibleWith' ? 'ignoreIncompatible' : kind === 'ignoreIncompatible' ? 'incompatibleWith' : null
      if (opposite) delete r[opposite][t]
    } else throw new Error('unknown rule kind: ' + kind)
    await saveUser()
    return r
  }
  const removeUserRule = async ({ packageId, kind, target }) => {
    const k = pid(packageId)
    const r = state.user.rules[k]
    if (!r) return false
    if (kind === 'loadTop' || kind === 'loadBottom') r[kind] = null
    else if (r[kind]) delete r[kind][pid(target)]
    const empty = !r.loadTop && !r.loadBottom && ['loadAfter', 'loadBefore', 'incompatibleWith', 'ignoreIncompatible'].every((f) => !Object.keys(r[f] || {}).length)
    if (empty) delete state.user.rules[k]
    await saveUser()
    return true
  }
  /** Replace the whole user rule set (import from RimSort userRules.json etc.). merge=true keeps existing. */
  const importUserRules = async (raw, { merge = true } = {}) => {
    const incoming = normalizeRules(raw?.rules || raw)
    if (!merge) state.user.rules = {}
    for (const [k, r] of Object.entries(incoming)) {
      const cur = state.user.rules[k] || (state.user.rules[k] = { loadAfter: {}, loadBefore: {}, incompatibleWith: {}, ignoreIncompatible: {}, loadTop: null, loadBottom: null })
      for (const f of ['loadAfter', 'loadBefore', 'incompatibleWith', 'ignoreIncompatible']) Object.assign(cur[f] || (cur[f] = {}), r[f] || {})
      if (r.loadTop) cur.loadTop = r.loadTop
      if (r.loadBottom) cur.loadBottom = r.loadBottom
    }
    await saveUser()
    return Object.keys(incoming).length
  }
  const exportUserRules = () => {
    const plain = {}
    for (const [k, r] of Object.entries(state.user.rules)) {
      const o = {}
      for (const f of ['loadAfter', 'loadBefore', 'incompatibleWith', 'ignoreIncompatible']) if (Object.keys(r[f] || {}).length) o[f] = r[f]
      if (r.loadTop) o.loadTop = { value: true, comment: r.loadTop.comment || '' }
      if (r.loadBottom) o.loadBottom = { value: true, comment: r.loadBottom.comment || '' }
      plain[k] = o
    }
    return { timestamp: Date.now(), rules: plain }
  }
  const setEnabled = (source, on) => {
    if (source === 'user') state.userEnabled = !!on
    else if (source in DB_DEFS) state.config[source].mode = on ? (state.config[source].mode === 'none' ? 'github' : state.config[source].mode) : 'none'
  }

  // ---- queries ----
  const rulesFor = (packageId) => {
    const k = pid(packageId)
    const merged = { loadAfter: {}, loadBefore: {}, incompatibleWith: {}, ignoreIncompatible: {}, loadTop: null, loadBottom: null }
    const apply = (r, source) => {
      if (!r) return
      for (const f of ['loadAfter', 'loadBefore', 'incompatibleWith', 'ignoreIncompatible']) for (const [t, info] of Object.entries(r[f] || {})) merged[f][t] = { ...info, source }
      if (r.loadTop) merged.loadTop = { ...r.loadTop, source }
      if (r.loadBottom) merged.loadBottom = { ...r.loadBottom, source }
    }
    if (cfg('community').mode !== 'none') apply(state.community.rules[k], 'community')
    if (state.userEnabled) apply(state.user.rules[k], 'user')
    return merged
  }
  /** True when the user asked to suppress the incompatibility between a and b (either direction). */
  const ignoresIncompatible = (a, b) => {
    if (!state.userEnabled) return false
    const ka = pid(a)
    const kb = pid(b)
    return !!(state.user.rules[ka]?.ignoreIncompatible?.[kb] || state.user.rules[kb]?.ignoreIncompatible?.[ka])
  }
  const steamByPid = (packageId) => (cfg('steam').mode !== 'none' ? state.steam.byPid.get(pid(packageId)) : undefined)
  const steamByPfid = (pfid) => (cfg('steam').mode !== 'none' ? state.steam.byPfid.get(String(pfid)) : undefined)
  const nvwCovers = (packageId) => cfg('noVersionWarning').mode !== 'none' && state.noVersionWarning.ids.has(pid(packageId))
  /** Replacement suggestion for an installed mod (by workshop id first, then packageId). */
  const replacementFor = ({ publishedFileId, packageId }) => {
    if (cfg('useThisInstead').mode === 'none') return undefined
    const pf = publishedFileId ? String(publishedFileId) : ''
    // Exact workshop-id match is authoritative.
    if (pf) {
      const e = state.useThisInstead.byOldPfid.get(pf)
      return e && e.newPfid !== pf ? e : undefined
    }
    // packageId fallback only for local copies (no workshop id), and not when the
    // replacement keeps the same packageId (a re-upload: the id cannot tell old from new).
    const e = packageId ? state.useThisInstead.byOldPid.get(pid(packageId)) : undefined
    if (!e || (e.newPackageId && e.newPackageId === pid(packageId))) return undefined
    return e
  }
  const gameVersions = () => state.versions.list
  const userRules = () => state.user.rules
  const communityRules = () => state.community.rules

  return { ensure, status, refresh, configure, getConfig, rulesFor, ignoresIncompatible, steamByPid, steamByPfid, nvwCovers, replacementFor, gameVersions, addUserRule, removeUserRule, importUserRules, exportUserRules, userRules, communityRules, setEnabled, state }
}
