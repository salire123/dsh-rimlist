/**
 * Named mod lists: save / load / import / export / diff.
 *
 * Storage: <dataDir>/lists/<id>.json
 *   { id, name, description, author, createdAt, updatedAt, gameVersion,
 *     mods: [{ packageId, name, publishedFileId?, version? }], source?: { kind, url } }
 *
 * Export formats:
 *   rimlist  — the JSON above (self-describing, best for sharing between players)
 *   rimsort  — RimSort-style ModsConfig.xml with an extra <rimlist> comment block? No: RimSort
 *              reads/writes ModsConfig.xml directly, so "rimsort" == modsconfig
 *   modsconfig — RimWorld ModsConfig.xml
 *   ids      — plain text packageIds, one per line
 *   markdown — table with names + workshop links (for forum / Discord posts)
 */
import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildModsConfig, parseIdBlob, parseModsConfig, pid } from './xml.js'

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'list'

const SOURCES = new Set(['workshop', 'git', 'local', 'official'])
/** Only keep shareable remote urls (no local paths / credentials). */
export const cleanGit = (g) => {
  const url = typeof g === 'string' ? g : g?.url
  if (typeof url !== 'string' || !/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(url.trim())) return undefined
  const u = url.trim().replace(/^(https?:\/\/)[^/@]+@/, '$1')
  const branch = typeof g?.branch === 'string' && /^[\w./-]+$/.test(g.branch) && !g.branch.startsWith('-') && g.branch !== 'HEAD' ? g.branch : undefined
  return { url: u, ...(branch ? { branch } : {}) }
}

export function createListStore({ dataDir }) {
  const dir = path.join(dataDir, 'lists')

  const file = (id) => path.join(dir, id + '.json')
  const writeAtomic = async (f, text) => {
    await mkdir(path.dirname(f), { recursive: true })
    await writeFile(f + '.tmp', text, 'utf8')
    await rename(f + '.tmp', f)
  }

  const normalizeMods = (mods) =>
    (Array.isArray(mods) ? mods : [])
      .map((m) => (typeof m === 'string' ? { packageId: m } : m))
      .filter((m) => m && typeof m.packageId === 'string' && m.packageId.trim())
      .map((m) => ({
        packageId: m.packageId.trim(),
        name: typeof m.name === 'string' ? m.name : undefined,
        publishedFileId: m.publishedFileId ? String(m.publishedFileId) : undefined,
        version: typeof m.version === 'string' ? m.version : undefined,
        source: SOURCES.has(m.source) ? m.source : undefined,
        git: cleanGit(m.git),
      }))

  const all = async () => {
    await mkdir(dir, { recursive: true })
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
    const lists = []
    for (const n of names) {
      try {
        const l = JSON.parse(await readFile(path.join(dir, n), 'utf8'))
        if (l && typeof l === 'object' && Array.isArray(l.mods)) lists.push(l)
      } catch {}
    }
    return lists.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }
  const get = async (id) => {
    try {
      return JSON.parse(await readFile(file(id), 'utf8'))
    } catch {
      return null
    }
  }
  const summaries = async () => (await all()).map(({ mods, ...rest }) => ({ ...rest, count: mods.length }))

  /** Create or replace a list. `mods` entries: {packageId,name?,publishedFileId?}. */
  const save = async ({ id, name, description, author, gameVersion, mods, source }) => {
    const now = Date.now()
    const existing = id ? await get(id) : null
    const list = {
      id: id || slug(name) + '-' + randomUUID().slice(0, 6),
      name: String(name || existing?.name || 'Untitled list').slice(0, 120),
      description: String(description ?? existing?.description ?? '').slice(0, 4000),
      author: String(author ?? existing?.author ?? '').slice(0, 120),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      gameVersion: gameVersion || existing?.gameVersion || null,
      mods: normalizeMods(mods ?? existing?.mods),
      source: source ?? existing?.source ?? null,
    }
    await writeAtomic(file(list.id), JSON.stringify(list, null, 2))
    return list
  }
  const remove = async (id) => {
    try {
      await unlink(file(id))
      return true
    } catch {
      return false
    }
  }

  // ---- export ----
  const toText = (list, format, { gameVersionFull } = {}) => {
    switch (format) {
      case 'rimlist':
        return JSON.stringify({ format: 'dsh-rimlist/1', ...list }, null, 2)
      case 'modsconfig':
      case 'rimsort': {
        const ids = list.mods.map((m) => m.packageId)
        const exp = ids.filter((i) => /^ludeon\.rimworld\./i.test(i)).map(pid)
        return buildModsConfig({ version: gameVersionFull || list.gameVersion || '', activeMods: ids, knownExpansions: exp })
      }
      case 'ids':
        return list.mods.map((m) => m.packageId).join('\n') + '\n'
      case 'markdown': {
        const lines = [`# ${list.name}`, '', list.description ? list.description + '\n' : '', `${list.mods.length} mods · RimWorld ${list.gameVersion || '?'}${list.author ? ' · by ' + list.author : ''}`, '', '| # | Mod | packageId | Workshop |', '|---|-----|-----------|----------|']
        list.mods.forEach((m, i) => lines.push(`| ${i + 1} | ${m.name || ''} | \`${m.packageId}\` | ${m.git && m.source === 'git' ? `[git](${m.git.url})${m.git.branch ? ' `' + m.git.branch + '`' : ''}` : m.publishedFileId ? `[${m.publishedFileId}](https://steamcommunity.com/sharedfiles/filedetails/?id=${m.publishedFileId})` : ''} |`))
        return lines.join('\n') + '\n'
      }
      default:
        throw new Error('unknown export format: ' + format)
    }
  }

  // ---- import ----
  /**
   * Parse any supported text into { name?, description?, author?, gameVersion?, mods[] }.
   * Accepts: dsh-rimlist JSON, RimSort/RimPy JSON-ish ({mods:[...]} or arrays), ModsConfig.xml,
   * a Steam collection page HTML (extracts workshop ids), plain id list, markdown table.
   */
  const parseText = (text, hint = {}) => {
    const t = String(text || '').trim()
    if (!t) throw new Error('empty input')
    // JSON
    if (t.startsWith('{') || t.startsWith('[')) {
      let j
      try {
        j = JSON.parse(t)
      } catch (e) {
        throw new Error('invalid JSON: ' + e.message)
      }
      if (Array.isArray(j)) return { mods: normalizeMods(j) }
      if (Array.isArray(j.mods)) return { name: j.name, description: j.description, author: j.author, gameVersion: j.gameVersion, mods: normalizeMods(j.mods) }
      if (Array.isArray(j.activeMods)) return { name: j.name, gameVersion: j.version, mods: normalizeMods(j.activeMods) }
      // RimPy / RimSort "modlist" exports sometimes keyed by packageId
      const entries = Object.entries(j).filter(([k]) => /^[\w.-]+$/.test(k))
      if (entries.length) return { mods: normalizeMods(entries.map(([k, v]) => ({ packageId: k, name: v?.name, publishedFileId: v?.publishedfileid || v?.publishedFileId }))) }
      throw new Error('JSON does not look like a mod list')
    }
    // ModsConfig.xml
    if (t.startsWith('<')) {
      if (/<ModsConfigData/i.test(t)) {
        const cfg = parseModsConfig(t)
        return { gameVersion: cfg.version, mods: normalizeMods(cfg.activeMods) }
      }
      // Steam collection HTML: collect workshop ids
      const ids = [...new Set([...t.matchAll(/sharedfiles\/filedetails\/\?id=(\d{6,})/g)].map((m) => m[1]))]
      if (ids.length) return { mods: ids.map((id) => ({ packageId: 'steam:' + id, publishedFileId: id })) }
      const li = parseIdBlob(t)
      if (li.length) return { mods: normalizeMods(li) }
      throw new Error('XML/HTML does not contain a mod list')
    }
    // Markdown table produced by us
    if (/^\|.*\|\s*$/m.test(t)) {
      const mods = []
      for (const line of t.split('\n')) {
        const m = line.match(/^\|\s*\d+\s*\|\s*(.*?)\s*\|\s*`([^`]+)`\s*\|\s*(?:\[(\d+)\])?(?:\[git\]\(([^)\s]+)\)(?:\s*`([^`]+)`)?)?/)
        if (m) mods.push({ packageId: m[2], name: m[1] || undefined, publishedFileId: m[3] || undefined, ...(m[4] ? { source: 'git', git: { url: m[4], branch: m[5] } } : m[3] ? { source: 'workshop' } : {}) })
      }
      if (mods.length) return { name: t.match(/^#\s+(.+)$/m)?.[1], mods: normalizeMods(mods) }
    }
    // Plain ids / workshop urls
    const urls = [...t.matchAll(/(?:id=|CommunityFilePage\/)(\d{6,})/g)].map((m) => m[1])
    const ids = parseIdBlob(t.replace(/https?:\S+/g, ''))
    const mods = [...ids.map((id) => ({ packageId: id })), ...urls.map((id) => ({ packageId: 'steam:' + id, publishedFileId: id }))]
    if (!mods.length) throw new Error('no packageIds found in input')
    return { mods: normalizeMods(mods) }
  }

  /**
   * Resolve a parsed list against the installed catalog + Steam DB so that
   * `steam:<pfid>` placeholders become packageIds and names fill in.
   */
  const resolveMods = (mods, catalog, ruleStore) =>
    mods.map((m) => {
      let packageId = m.packageId
      let pfid = m.publishedFileId
      if (packageId.startsWith('steam:')) {
        const byPfid = ruleStore?.steamByPfid(pfid) || [...catalog.values()].find((c) => c.publishedFileId === pfid)
        if (byPfid?.packageId) packageId = byPfid.packageId
      }
      const installed = catalog.get(pid(packageId))
      const steam = installed?.publishedFileId ? ruleStore?.steamByPfid(installed.publishedFileId) : ruleStore?.steamByPid(packageId)
      return {
        packageId,
        name: m.name || installed?.name || steam?.name || undefined,
        publishedFileId: pfid || installed?.publishedFileId || steam?.pfid || undefined,
        version: m.version,
        source: m.source,
        git: m.git,
        installed: !!installed,
        unresolved: packageId.startsWith('steam:'),
      }
    })

  /** Diff two id arrays (ordered). */
  const diff = (fromIds, toIds) => {
    const a = fromIds.map(pid)
    const b = toIds.map(pid)
    const sa = new Set(a)
    const sb = new Set(b)
    const added = b.filter((k) => !sa.has(k))
    const removed = a.filter((k) => !sb.has(k))
    const common = a.filter((k) => sb.has(k))
    const bIndex = new Map(b.map((k, i) => [k, i]))
    // LIS over common items by their position in b → items not in LIS were reordered
    const seq = common.map((k) => bIndex.get(k))
    const lis = longestIncreasing(seq)
    const kept = new Set(lis.map((i) => common[i]))
    const reordered = common.filter((k) => !kept.has(k))
    return { added, removed, reordered, same: common.length - reordered.length, total: { from: a.length, to: b.length } }
  }

  return { all, get, summaries, save, remove, toText, parseText, resolveMods, diff }
}

function longestIncreasing(seq) {
  const tails = []
  const prev = new Array(seq.length).fill(-1)
  const idx = []
  for (let i = 0; i < seq.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < seq[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
    idx[lo] = i
  }
  const out = []
  let k = tails.length ? tails[tails.length - 1] : -1
  while (k >= 0) {
    out.push(k)
    k = prev[k]
  }
  return out.reverse()
}
