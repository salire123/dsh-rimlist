/**
 * Mod scanner: walk Data/ (Core + DLC), <game>/Mods/ (local) and the Steam
 * workshop folder, parse About.xml and return a normalized catalog.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseAbout, parseLoadFolders, pid } from './xml.js'
import { exists, listDirs } from './paths.js'

const CORE_ID = 'ludeon.rimworld'
const KNOWN_EXPANSIONS = {
  'ludeon.rimworld.royalty': 1149640,
  'ludeon.rimworld.ideology': 1392840,
  'ludeon.rimworld.biotech': 1826140,
  'ludeon.rimworld.anomaly': 2380740,
  'ludeon.rimworld.odyssey': 3022790,
}
const OFFICIAL_NAMES = {
  'ludeon.rimworld': 'Core',
  'ludeon.rimworld.royalty': 'Royalty',
  'ludeon.rimworld.ideology': 'Ideology',
  'ludeon.rimworld.biotech': 'Biotech',
  'ludeon.rimworld.anomaly': 'Anomaly',
  'ludeon.rimworld.odyssey': 'Odyssey',
}

async function readAboutIn(dir) {
  // About.xml may be About/About.xml with varying case on case-sensitive FS.
  for (const rel of ['About/About.xml', 'about/about.xml', 'About/about.xml', 'about/About.xml']) {
    const p = path.join(dir, rel)
    if (await exists(p)) return { path: p, xml: await readFile(p, 'utf8') }
  }
  return null
}

async function readPublishedId(dir) {
  for (const rel of ['About/PublishedFileId.txt', 'about/PublishedFileId.txt']) {
    const p = path.join(dir, rel)
    if (await exists(p)) {
      const t = (await readFile(p, 'utf8')).trim()
      if (/^\d+$/.test(t)) return t
    }
  }
  return null
}

async function findPreview(dir) {
  for (const rel of ['About/Preview.png', 'About/preview.png', 'About/Preview.jpg', 'About/ModIcon.png']) {
    if (await exists(path.join(dir, rel))) return path.join(dir, rel)
  }
  return null
}

async function scanOne(dir, source, major, folderName) {
  const about = await readAboutIn(dir)
  if (!about) return null
  let meta
  try {
    meta = parseAbout(about.xml, major)
  } catch (err) {
    return {
      packageId: pid(folderName),
      key: pid(folderName),
      name: folderName,
      source,
      path: dir,
      folder: folderName,
      invalid: 'About.xml parse error: ' + ((err && err.message) || err),
      supportedVersions: [],
      loadAfter: [], loadBefore: [], forceLoadAfter: [], forceLoadBefore: [], incompatibleWith: [], modDependencies: [],
    }
  }
  let publishedFileId = await readPublishedId(dir)
  if (!publishedFileId && source === 'workshop' && /^\d+$/.test(folderName)) publishedFileId = folderName
  let loadFolderVersions = []
  const lf = path.join(dir, 'LoadFolders.xml')
  if (await exists(lf)) loadFolderVersions = parseLoadFolders(await readFile(lf, 'utf8'))
  let mtime = 0
  try {
    mtime = (await stat(about.path)).mtimeMs
  } catch {}
  const key = pid(meta.packageId) || pid(folderName)
  const isCore = key === CORE_ID
  const isExpansion = key in KNOWN_EXPANSIONS || (source === 'official' && !isCore)
  const supported = meta.supportedVersions.length ? meta.supportedVersions : meta.targetVersion ? [meta.targetVersion.match(/\d+\.\d+/)?.[0]].filter(Boolean) : []
  return {
    ...meta,
    key,
    packageId: meta.packageId || folderName,
    name: (source === 'official' && OFFICIAL_NAMES[key]) || meta.name || folderName,
    author: meta.author || (source === 'official' ? 'Ludeon Studios' : ''),
    source, // official | local | workshop
    kind: isCore ? 'core' : isExpansion ? 'expansion' : 'mod',
    path: dir,
    folder: folderName,
    publishedFileId,
    steamAppId: meta.steamAppId || (KNOWN_EXPANSIONS[key] ? String(KNOWN_EXPANSIONS[key]) : null),
    preview: await findPreview(dir),
    supportedVersions: isCore && !supported.length && major ? [major] : supported,
    loadFolderVersions,
    mtime,
    invalid: meta.packageId ? null : 'Missing <packageId>',
  }
}

/**
 * Scan all mod sources. Returns { mods: Mod[], byId: Map<key, Mod>, duplicates: {key, paths[]}[] }.
 * Workshop entries win over local copies only when the user asks; by default
 * local (Mods/) copies shadow workshop copies, which matches the game.
 */
export async function scanMods({ gameDir, localModsDir, workshopDir, major, extraDirs = [] }) {
  const found = []
  const push = async (base, source) => {
    if (!base || !(await exists(base))) return
    const names = await listDirs(base)
    await Promise.all(
      names.map(async (name) => {
        const m = await scanOne(path.join(base, name), source, major, name)
        if (m) found.push(m)
      }),
    )
  }
  if (gameDir) await push(path.join(gameDir, 'Data'), 'official')
  await push(localModsDir, 'local')
  for (const d of extraDirs) await push(d, 'local')
  await push(workshopDir, 'workshop')

  // Resolve duplicates: official > local > workshop (game's own precedence).
  const rank = { official: 0, local: 1, workshop: 2 }
  found.sort((a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name))
  const byId = new Map()
  const duplicates = new Map()
  for (const m of found) {
    if (!byId.has(m.key)) byId.set(m.key, m)
    else {
      const d = duplicates.get(m.key) || [byId.get(m.key).path]
      d.push(m.path)
      duplicates.set(m.key, d)
    }
  }
  const mods = [...byId.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'core' ? -1 : b.kind === 'core' ? 1 : a.kind === 'expansion' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return { mods, byId, duplicates: [...duplicates.entries()].map(([key, paths]) => ({ key, paths })) }
}

export { CORE_ID, KNOWN_EXPANSIONS }
