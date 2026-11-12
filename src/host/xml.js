/**
 * About.xml / ModsConfig.xml / LoadFolders.xml parsing and ModsConfig writing.
 * packageIds are compared case-insensitively everywhere (RimWorld does the same);
 * we keep the original spelling for display and normalize with `pid()` for keys.
 */
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export const pid = (s) => String(s || '').trim().toLowerCase()

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === 'li',
})

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const liList = (node) => asArray(node && node.li).map((x) => (typeof x === 'object' ? x['#text'] ?? x : x)).map((x) => String(x ?? '').trim()).filter(Boolean)
const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim()

/** Versioned override blocks such as <loadAfterByVersion><v1.6><li>..</li></v1.6></loadAfterByVersion>. */
function byVersion(node, major) {
  if (!node || typeof node !== 'object' || !major) return null
  const key = 'v' + major
  if (node[key] !== undefined) return liList(node[key])
  return null
}

/** Dependency entries: <modDependencies><li><packageId/><displayName/><steamWorkshopUrl/><downloadUrl/></li></modDependencies>. */
function depList(node, major, versioned) {
  let items = asArray(node && node.li)
  if (versioned && typeof versioned === 'object' && versioned['v' + major]) items = asArray(versioned['v' + major].li)
  return items
    .map((li) => (typeof li === 'object' ? li : { packageId: li }))
    .map((li) => ({
      packageId: text(li.packageId),
      displayName: text(li.displayName) || text(li.packageId),
      steamWorkshopUrl: text(li.steamWorkshopUrl) || null,
      downloadUrl: text(li.downloadUrl) || null,
    }))
    .filter((d) => d.packageId)
}

/**
 * Parse About.xml text into normalized metadata. `major` is the game version
 * (e.g. "1.6") used to resolve *ByVersion overrides.
 */
export function parseAbout(xml, major) {
  const doc = parser.parse(xml)
  const m = doc.ModMetaData || doc.modMetaData || {}
  const pick = (base, versionedKey) => {
    const v = byVersion(m[versionedKey], major)
    return v !== null ? v : liList(m[base])
  }
  const packageId = text(m.packageId)
  return {
    packageId,
    name: text(m.name) || packageId,
    author: text(m.author) || liList(m.authors).join(', ') || '',
    url: text(m.url) || null,
    description: text(m.description),
    modVersion: text(m.modVersion) || null,
    supportedVersions: liList(m.supportedVersions).map((v) => v.match(/\d+\.\d+/)?.[0] || v),
    targetVersion: text(m.targetVersion) || null, // legacy (pre-1.1) field
    loadAfter: pick('loadAfter', 'loadAfterByVersion'),
    loadBefore: pick('loadBefore', 'loadBeforeByVersion'),
    forceLoadAfter: liList(m.forceLoadAfter),
    forceLoadBefore: liList(m.forceLoadBefore),
    incompatibleWith: pick('incompatibleWith', 'incompatibleWithByVersion'),
    modDependencies: depList(m.modDependencies, major, m.modDependenciesByVersion),
    steamAppId: text(m.steamAppId) || null,
  }
}

/** Parse ModsConfig.xml: { version, activeMods: string[], knownExpansions: string[] }. */
export function parseModsConfig(xml) {
  const doc = parser.parse(xml)
  const d = doc.ModsConfigData || {}
  return {
    version: text(d.version),
    activeMods: liList(d.activeMods),
    knownExpansions: liList(d.knownExpansions),
  }
}

/**
 * Serialize ModsConfig.xml exactly in RimWorld's layout. Ids are written lowercase:
 * RimWorld matches them case-sensitively against lowercased packageIds, so a mixed-case
 * id ("Ludeon.RimWorld") shows up as a greyed duplicate in both columns of the game's mod menu.
 */
export function buildModsConfig({ version, activeMods, knownExpansions }) {
  const lower = (a) => { const seen = new Set(); return (a || []).map(pid).filter((k) => k && !seen.has(k) && seen.add(k)) }
  activeMods = lower(activeMods)
  knownExpansions = lower(knownExpansions)
  const builder = new XMLBuilder({ format: true, indentBy: '  ', suppressEmptyNode: false })
  const body = builder.build({
    ModsConfigData: {
      version: version || '',
      activeMods: { li: activeMods },
      knownExpansions: { li: knownExpansions || [] },
    },
  })
  return '<?xml version="1.0" encoding="utf-8"?>\n' + body
}

/** Parse LoadFolders.xml: list of versions a mod declares folders for (helps version detection). */
export function parseLoadFolders(xml) {
  try {
    const doc = parser.parse(xml)
    const lf = doc.loadFolders || {}
    return Object.keys(lf).filter((k) => /^v\d+\.\d+$/.test(k)).map((k) => k.slice(1))
  } catch {
    return []
  }
}

/** Tiny helper used by import: parse a ModsConfig-like <activeMods> blob or a plain-text id list. */
export function parseIdBlob(textBlob) {
  const t = String(textBlob || '').trim()
  if (!t) return []
  if (t.startsWith('<')) {
    try {
      const cfg = parseModsConfig(t)
      if (cfg.activeMods.length) return cfg.activeMods
    } catch {}
    const ids = [...t.matchAll(/<li>\s*([^<\s]+)\s*<\/li>/g)].map((m) => m[1])
    if (ids.length) return ids
  }
  return t.split(/[\r\n,;\s]+/).map((s) => s.trim()).filter((s) => s && /^[\w.\-]+$/.test(s))
}
