/**
 * RimWorld save files (*.rws): list them and read the mod list stored in their header.
 *
 * A save starts with
 *   <savegame><meta>
 *     <gameVersion>1.6.4871 rev598</gameVersion>
 *     <modIds><li>brrainz.harmony</li>…</modIds>
 *     <modSteamIds><li>2009463077</li>…</modSteamIds>   (0 = not from the workshop)
 *     <modNames><li>Harmony</li>…</modNames>
 *   </meta> …
 * Saves are often 20-100 MB, so only the head of the file is read (until </meta>).
 * Only reads the filesystem; never writes.
 */
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { XMLParser } from 'fast-xml-parser'

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true, parseTagValue: false, isArray: (name) => name === 'li' })
const CHUNK = 64 * 1024
const MAX_HEAD = 8 * 1024 * 1024

const liList = (node) =>
  (Array.isArray(node?.li) ? node.li : node?.li !== undefined ? [node.li] : [])
    .map((x) => (x && typeof x === 'object' ? x['#text'] ?? '' : x))
    .map((x) => String(x ?? '').trim())

/** Saves folder next to Config/ (…/RimWorld by Ludeon Studios/Saves). */
export const defaultSavesDir = (configDir) => (configDir ? path.join(path.dirname(configDir), 'Saves') : null)

/** "folder##name" is the convention of save-folder mods; split it so the UI can group. */
export const splitSaveName = (base) => {
  const i = base.lastIndexOf('##')
  return i > 0 ? { folder: base.slice(0, i), title: base.slice(i + 2) } : { folder: '', title: base }
}

/** Parse the <meta> block (text from the start of the file up to and including </meta>). */
export function parseSaveMeta(headText) {
  const t = String(headText || '')
  const end = t.indexOf('</meta>')
  const start = t.indexOf('<meta>')
  if (start < 0 || end < 0) throw new Error('not a RimWorld save (no <meta> block)')
  const doc = parser.parse(t.slice(start, end + 7))
  const meta = doc.meta || {}
  const ids = liList(meta.modIds)
  const steam = liList(meta.modSteamIds)
  const names = liList(meta.modNames)
  const mods = ids
    .map((packageId, i) => {
      const pfid = steam[i] && /^\d{6,}$/.test(steam[i]) ? steam[i] : undefined
      return { packageId, name: names[i] || undefined, publishedFileId: pfid }
    })
    .filter((m) => m.packageId)
  return { gameVersion: String(meta.gameVersion ?? '').trim() || null, mods }
}

/** Read just enough of a save file to get its <meta> block. */
export async function readSaveHead(file) {
  const fh = await open(file, 'r')
  try {
    const parts = []
    let total = 0
    let tail = ''
    const buf = Buffer.alloc(CHUNK)
    while (total < MAX_HEAD) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, total)
      if (!bytesRead) break
      const piece = Buffer.from(buf.subarray(0, bytesRead))
      parts.push(piece)
      total += bytesRead
      // Look for </meta> across the chunk boundary.
      const s = tail + piece.toString('latin1')
      if (s.includes('</meta>')) break
      tail = s.slice(-8)
    }
    return Buffer.concat(parts).toString('utf8')
  } finally {
    await fh.close()
  }
}

export async function readSaveMeta(file) {
  return parseSaveMeta(await readSaveHead(file))
}

/**
 * Cache of parsed headers keyed by path, invalidated by size + mtime.
 * list() returns every *.rws in the folder, newest first, with the mod count.
 */
export function createSaveStore() {
  const cache = new Map() // path -> { size, mtime, meta | error }

  const metaOf = async (file, st) => {
    const c = cache.get(file)
    if (c && c.size === st.size && c.mtime === st.mtimeMs) return c
    let entry
    try {
      entry = { size: st.size, mtime: st.mtimeMs, meta: await readSaveMeta(file) }
    } catch (e) {
      entry = { size: st.size, mtime: st.mtimeMs, error: String(e.message || e) }
    }
    cache.set(file, entry)
    return entry
  }

  /** Resolve a save name (file name, with or without .rws) inside dir; refuses path traversal. */
  const resolve = (dir, name) => {
    if (!dir) throw new Error('RimWorld Saves folder not found; set it in settings')
    const n = String(name || '')
    const base = n.toLowerCase().endsWith('.rws') ? n : n + '.rws'
    if (!n || base !== path.basename(base) || base.includes('/') || base.includes('\\') || base.startsWith('.')) throw new Error('bad save name')
    return path.join(dir, base)
  }

  const list = async (dir) => {
    if (!dir) return []
    let names
    try {
      names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.rws'))
    } catch {
      return []
    }
    const out = []
    // Small pool: headers are tiny, but there may be hundreds of saves.
    let i = 0
    const work = async () => {
      while (i < names.length) {
        const n = names[i++]
        const file = path.join(dir, n)
        try {
          const st = await stat(file)
          const e = await metaOf(file, st)
          const base = n.replace(/\.rws$/i, '')
          out.push({ name: n, base, ...splitSaveName(base), size: st.size, mtime: st.mtimeMs, gameVersion: e.meta?.gameVersion || null, modCount: e.meta?.mods.length ?? null, error: e.error || null })
        } catch {}
      }
    }
    await Promise.all(Array.from({ length: 6 }, work))
    // Forget files that are gone.
    const present = new Set(names.map((n) => path.join(dir, n)))
    for (const k of cache.keys()) if (path.dirname(k) === dir && !present.has(k)) cache.delete(k)
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  const get = async (dir, name) => {
    const file = resolve(dir, name)
    const st = await stat(file)
    const e = await metaOf(file, st)
    if (e.error) throw new Error(e.error)
    const base = path.basename(file).replace(/\.rws$/i, '')
    return { name: path.basename(file), base, ...splitSaveName(base), path: file, size: st.size, mtime: st.mtimeMs, ...e.meta }
  }

  return { list, get, resolve }
}
