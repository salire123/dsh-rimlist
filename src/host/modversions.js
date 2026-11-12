/**
 * Mod versions: workshop update log, snapshot backups (Steam can't roll back), git install/update.
 *
 * Workshop state comes from steamapps/workshop/appworkshop_294100.acf (Valve KeyValues):
 *   WorkshopItemsInstalled.<pfid>.timeupdated     -> version on disk
 *   WorkshopItemDetails.<pfid>.latest_timeupdated -> newest version Steam knows about
 * Changelog text is scraped from steamcommunity.com/sharedfiles/filedetails/changelog/<pfid>
 * (each entry is <p id="<unix time>">text</p>) and cached.
 *
 * Backups: <dataDir>/modbackups/<key>/<stamp>/ (full copy of the mod folder + meta.json).
 * Restoring copies a snapshot into the local Mods/ folder as "<folder>_rimlist_<stamp>"; RimWorld
 * prefers local copies over workshop copies with the same packageId, so this pins the old version
 * until the user removes it (Steam can't overwrite it).
 *
 * Git: `git clone --depth 1` into Mods/, `git pull --ff-only` to update; a backup is made first.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { exists } from './paths.js'

export const APPID = '294100'

/* ------------------------------------------------------------------ KeyValues (.acf/.vdf) */
export function parseVdf(text) {
  const root = {}
  const stack = [root]
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g
  let key = null
  let m
  while ((m = re.exec(text))) {
    if (m[2] === '{') {
      const obj = {}
      stack[stack.length - 1][key ?? ''] = obj
      stack.push(obj)
      key = null
    } else if (m[2] === '}') {
      stack.pop()
      key = null
      if (!stack.length) break
    } else if (key === null) key = m[1]
    else {
      stack[stack.length - 1][key] = m[1].replace(/\\(.)/g, '$1')
      key = null
    }
  }
  return root
}

/** workshopDir = .../steamapps/workshop/content/294100 -> .../steamapps/workshop/appworkshop_294100.acf */
export function acfPathFor(workshopDir) {
  if (!workshopDir) return null
  return path.join(path.dirname(path.dirname(workshopDir)), `appworkshop_${APPID}.acf`)
}

/** Map pfid -> { installed, latest, size, needsUpdate } (unix seconds). */
export async function readWorkshopState(workshopDir) {
  const f = acfPathFor(workshopDir)
  if (!f || !(await exists(f))) return { path: f, items: new Map() }
  const kv = parseVdf(await readFile(f, 'utf8'))
  const root = kv.AppWorkshop || kv.appworkshop || {}
  const inst = root.WorkshopItemsInstalled || {}
  const det = root.WorkshopItemDetails || {}
  const items = new Map()
  for (const [id, v] of Object.entries(inst)) {
    const d = det[id] || {}
    const installed = Number(v.timeupdated || d.timeupdated || 0)
    const latest = Number(d.latest_timeupdated || installed)
    items.set(id, { installed, latest, size: Number(v.size || 0), touched: Number(d.timetouched || 0), needsUpdate: latest > installed })
  }
  for (const [id, d] of Object.entries(det)) if (!items.has(id)) items.set(id, { installed: Number(d.timeupdated || 0), latest: Number(d.latest_timeupdated || 0), size: 0, touched: Number(d.timetouched || 0), needsUpdate: false })
  return { path: f, items, needsDownload: Number(root.NeedsDownload || 0) > 0 }
}

/* ------------------------------------------------------------------ changelog */
const decode = (s) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** Parse a Steam workshop changelog page into [{ time, text, auto }] newest first. */
export function parseChangelog(html) {
  const out = []
  const re = /<p id="(\d{9,11})">([\s\S]*?)<\/p>/g
  let m
  while ((m = re.exec(html))) {
    const text = decode(m[2])
    out.push({ time: Number(m[1]), text, auto: /^\[Auto-generated text\]/i.test(text) })
  }
  return out.sort((a, b) => b.time - a.time)
}

export function createChangelogCache({ dataDir, fetchImpl = globalThis.fetch, log = () => {} }) {
  const dir = path.join(dataDir, 'changelogs')
  const mem = new Map()
  const file = (pfid) => path.join(dir, pfid + '.json')
  /** maxAgeSec: refetch when the cached copy is older, or when `needTime` is newer than the newest entry. */
  const get = async (pfid, { maxAgeSec = 6 * 3600, needTime = 0, force = false } = {}) => {
    if (!/^\d+$/.test(String(pfid))) return { entries: [], fetchedAt: 0 }
    let c = mem.get(pfid)
    if (!c) {
      try {
        c = JSON.parse(await readFile(file(pfid), 'utf8'))
      } catch {}
    }
    const now = Date.now() / 1000
    const stale = !c || force || now - c.fetchedAt > maxAgeSec || (needTime && !(c.entries[0]?.time >= needTime))
    if (stale && fetchImpl) {
      try {
        const r = await fetchImpl(`https://steamcommunity.com/sharedfiles/filedetails/changelog/${pfid}?l=english`, { headers: { 'user-agent': 'Mozilla/5.0 dsh-rimlist' }, signal: AbortSignal.timeout(15000) })
        if (r.ok) {
          c = { fetchedAt: now, entries: parseChangelog(await r.text()) }
          await mkdir(dir, { recursive: true })
          await writeFile(file(pfid), JSON.stringify(c))
        }
      } catch (e) {
        log('changelog ' + pfid + ': ' + e.message)
      }
    }
    if (c) mem.set(pfid, c)
    return c || { entries: [], fetchedAt: 0 }
  }
  return { get }
}

/* ------------------------------------------------------------------ backups */
const safe = (s) => String(s).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80)

async function dirSize(dir) {
  let total = 0
  const walk = async (d) => {
    let ents = []
    try {
      ents = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === '.git') continue
        await walk(p)
      } else if (e.isFile()) total += (await stat(p)).size
    }
  }
  await walk(dir)
  return total
}

export function createBackupStore({ dataDir }) {
  const root = path.join(dataDir, 'modbackups')
  const modDir = (key) => path.join(root, safe(key))

  /** List snapshots of one mod (newest first) or all mods. */
  const list = async (key) => {
    const keys = key ? [safe(key)] : await readdir(root).catch(() => [])
    const out = []
    for (const k of keys) {
      const d = path.join(root, k)
      const snaps = await readdir(d).catch(() => [])
      for (const s of snaps) {
        try {
          const meta = JSON.parse(await readFile(path.join(d, s, 'meta.json'), 'utf8'))
          out.push({ ...meta, id: k + '/' + s, dir: path.join(d, s, 'mod') })
        } catch {}
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Copy a mod folder into a snapshot. Skips if a snapshot with the same version stamp already exists. */
  const backup = async (mod, { version, reason = 'manual', keep = 5 } = {}) => {
    if (!mod?.path) throw new Error('mod has no folder')
    const stamp = safe(version || String(Math.floor((mod.mtime || Date.now()) / 1000)))
    const dest = path.join(modDir(mod.key), stamp)
    if (await exists(path.join(dest, 'meta.json'))) return { skipped: true, id: safe(mod.key) + '/' + stamp }
    const tmp = dest + '.tmp-' + process.pid
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    await cp(mod.path, path.join(tmp, 'mod'), { recursive: true, filter: (src) => path.basename(src) !== '.git' })
    const size = await dirSize(path.join(tmp, 'mod'))
    const meta = { key: mod.key, packageId: mod.packageId, name: mod.name, source: mod.source, folder: mod.folder, publishedFileId: mod.publishedFileId || null, version: stamp, modVersion: mod.modVersion || null, reason, size, createdAt: Date.now(), origin: mod.path }
    await writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta, null, 2))
    await rm(dest, { recursive: true, force: true })
    await rename(tmp, dest)
    await prune(mod.key, keep)
    return { ...meta, id: safe(mod.key) + '/' + stamp }
  }

  const prune = async (key, keep) => {
    if (!keep || keep < 1) return
    const snaps = await list(key)
    for (const s of snaps.slice(keep)) await rm(path.dirname(s.dir), { recursive: true, force: true })
  }

  const remove = async (id) => {
    const [k, s] = String(id).split('/')
    if (!k || !s || k.includes('..') || s.includes('..')) throw new Error('bad backup id')
    await rm(path.join(root, k, s), { recursive: true, force: true })
  }

  /** Install a snapshot into localModsDir as its own folder. Returns the new folder path. */
  const restore = async (id, localModsDir) => {
    if (!localModsDir) throw new Error('local Mods folder not found')
    const [k, s] = String(id).split('/')
    if (!k || !s || k.includes('..') || s.includes('..')) throw new Error('bad backup id')
    const src = path.join(root, k, s)
    const meta = JSON.parse(await readFile(path.join(src, 'meta.json'), 'utf8'))
    const folder = `${safe(meta.folder || meta.key)}_rimlist_${s}`
    const dest = path.join(localModsDir, folder)
    await mkdir(localModsDir, { recursive: true })
    await rm(dest, { recursive: true, force: true })
    await cp(path.join(src, 'mod'), dest, { recursive: true })
    await writeFile(path.join(dest, '.rimlist-restored.json'), JSON.stringify({ from: id, restoredAt: Date.now(), meta }, null, 2))
    return { path: dest, folder, meta }
  }

  const usage = async () => {
    const all = await list()
    return { count: all.length, bytes: all.reduce((a, b) => a + (b.size || 0), 0), root }
  }

  return { list, backup, remove, restore, usage, root }
}

/* ------------------------------------------------------------------ git */
export function runGit(args, { cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim().split('\n').slice(-3).join(' ')
        reject(new Error(err.code === 'ENOENT' ? 'git is not installed' : msg))
      } else resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

/** Accept https / ssh / "owner/repo" GitHub shorthand. Rejects option-like or local paths. */
export function normalizeGitUrl(input) {
  let u = String(input || '').trim()
  if (!u || u.startsWith('-')) throw new Error('invalid git url')
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = `https://github.com/${u}`
  u = u.replace(/^(https:\/\/github\.com\/[^/]+\/[^/#?]+)\/(tree|blob)\/.*$/, '$1')
  if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(u)) throw new Error('only http(s) / ssh git urls are supported')
  return u
}

export const repoName = (url) => (url.replace(/\.git$/, '').split(/[/:]/).pop() || 'mod').replace(/[^\w.-]+/g, '_')

export async function gitInfo(dir) {
  if (!(await exists(path.join(dir, '.git')))) return null
  try {
    const [remote, head, branch, last] = await Promise.all([
      runGit(['config', '--get', 'remote.origin.url'], { cwd: dir }).then((r) => r.stdout).catch(() => ''),
      runGit(['rev-parse', '--short', 'HEAD'], { cwd: dir }).then((r) => r.stdout),
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).then((r) => r.stdout).catch(() => ''),
      runGit(['log', '-1', '--format=%ct%x09%s'], { cwd: dir }).then((r) => r.stdout).catch(() => ''),
    ])
    const [t, ...subj] = last.split('\t')
    return { remote, head, branch, lastCommitTime: Number(t) || 0, lastCommit: subj.join('\t') }
  } catch {
    return null
  }
}

/** Fetch and report how many commits behind origin + their subjects (the update log for git mods). */
export async function gitCheck(dir) {
  await runGit(['fetch', '--quiet', 'origin'], { cwd: dir, timeoutMs: 60000 })
  const up = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: dir }).then((r) => r.stdout).catch(() => 'origin/HEAD')
  const behind = Number((await runGit(['rev-list', '--count', `HEAD..${up}`], { cwd: dir })).stdout) || 0
  const log = behind ? (await runGit(['log', '--format=%ct%x09%h%x09%s', `HEAD..${up}`, '-n', '50'], { cwd: dir })).stdout : ''
  const commits = log ? log.split('\n').map((l) => { const [t, h, ...s] = l.split('\t'); return { time: Number(t), hash: h, text: s.join('\t') } }) : []
  return { behind, upstream: up, commits }
}

export async function gitRecentLog(dir, n = 30) {
  const log = (await runGit(['log', '--format=%ct%x09%h%x09%s', '-n', String(n)], { cwd: dir })).stdout
  return log ? log.split('\n').map((l) => { const [t, h, ...s] = l.split('\t'); return { time: Number(t), hash: h, text: s.join('\t') } }) : []
}
