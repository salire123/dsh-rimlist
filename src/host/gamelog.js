/**
 * RimWorld Player.log reader.
 *
 * RimWorld 1.7+ writes Logs/Player.log, older (Unity) builds write Player.log next to the Config folder:
 *   Linux   ~/.config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios/Player.log
 *   Windows %USERPROFILE%\AppData\LocalLow\Ludeon Studios\RimWorld by Ludeon Studios\Player.log
 *   macOS   ~/Library/Logs/Ludeon Studios/RimWorld by Ludeon Studios/Player.log
 * Player-prev.log is the previous run.
 */
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { homedir, platform } from 'node:os'
import { exists } from './paths.js'

export function logCandidates(configDir) {
  const H = homedir()
  const out = []
  if (configDir) out.push(path.dirname(configDir))
  if (platform() === 'darwin') out.push(path.join(H, 'Library/Logs/Ludeon Studios/RimWorld by Ludeon Studios'))
  else if (platform() === 'win32') out.push(path.join(process.env.USERPROFILE || H, 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios'))
  else {
    out.push(path.join(H, '.config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios'))
    out.push(path.join(H, '.var/app/com.valvesoftware.Steam/.config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios'))
  }
  return [...new Set(out)]
}

/**
 * RimWorld 1.7+ (Waylith engine) writes to <dir>/Logs/Player.log; older Unity builds
 * write <dir>/Player.log. Both may exist after an upgrade, so pick the newest one.
 */
export async function findLogFile(configDir, { previous = false } = {}) {
  const name = previous ? 'Player-prev.log' : 'Player.log'
  let best = null
  for (const d of logCandidates(configDir)) {
    for (const f of [path.join(d, 'Logs', name), path.join(d, name)]) {
      if (!(await exists(f))) continue
      const m = (await stat(f)).mtimeMs
      if (!best || m > best.m) best = { f, m }
    }
  }
  return best?.f || null
}

const MAX_READ = 4 * 1024 * 1024

/** Read a log file (tail-capped) and return { path, size, mtime, lines }. */
export async function readLogFile(file) {
  const st = await stat(file)
  const start = Math.max(0, st.size - MAX_READ)
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(st.size - start)
    await fh.read(buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { path: file, size: st.size, mtime: st.mtimeMs, truncated: start > 0, text }
  } finally {
    await fh.close()
  }
}

/** Unity noise that is never useful when hunting mod errors. */
const NOISE = [/^\(Filename: .*Line: \d+\)$/, /^UnityEngine\.(StackTraceUtility|Debug|Logger|DebugLogHandler)[:.]/, /^\s*$/, /(^|\s)GL_[A-Z0-9]+_\w+(\s|$).*GL_/, /^Fallback handler could not load library/]
const isNoise = (l) => NOISE.some((r) => r.test(l))

/**
 * Split the log into entries: a message line followed by its stack trace lines.
 * level: error (exceptions, "Error", "Could not", "Exception"), warning, info.
 */
/** 1.7+ structured line: "2026-10-14 18:33:01.323  WARN [Verse] message". */
const STRUCT = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\s+(?:\[([^\]]{1,60})\]\s*)?(.*)$/
/** Logger plumbing frames repeated under every 1.7 entry. */
const LOG_FRAMES = /^\s+at (Brutal\.Logging\.|Verse\.Log\.(Message|Warning|Error|ErrorOnce|WarningOnce)\(|HarmonyGenerated\.Verse\.Log\.)/
const STRUCT_LEVEL = { TRACE: 'info', DEBUG: 'info', INFO: 'info', WARN: 'warning', WARNING: 'warning', ERROR: 'error', FATAL: 'error', CRITICAL: 'error' }

export function parseLog(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  let cur = null
  const flush = () => {
    if (cur) entries.push(cur)
    cur = null
  }
  if (lines.slice(0, 40).some((l) => STRUCT.test(l))) {
    // New format: every entry starts with a timestamp; everything else is continuation.
    for (const raw of lines) {
      const m = raw.match(STRUCT)
      if (m) {
        flush()
        // Drop the engine's generic "[Verse]" category so "[Mod] msg" prefixes still attribute.
        const msg = m[2] && m[2] !== 'Verse' ? `[${m[2]}] ${m[3]}` : m[3]
        cur = { line: msg, level: STRUCT_LEVEL[m[1]], trace: [] }
      } else if (cur) {
        if (raw.trim() && !LOG_FRAMES.test(raw) && cur.trace.length < 40) cur.trace.push(raw)
      } else if (raw.trim() && !/^===/.test(raw)) {
        entries.push({ line: raw, level: 'info', trace: [] })
      }
    }
    flush()
  } else for (const raw of lines) {
    if (isNoise(raw)) continue
    const isTrace = /^\s+at |^\s*\(wrapper |^\s*--- End of|^\s*Verse\.|^\s*RimWorld\.|^[A-Za-z0-9_.]+:[A-Za-z0-9_<>]+ ?\(|^\[0x[0-9a-f]+\]|^  /.test(raw) && cur
    if (isTrace) {
      if (cur.trace.length < 40) cur.trace.push(raw)
      continue
    }
    flush()
    cur = { line: raw, level: levelOf(raw), trace: [] }
  }
  flush()
  // Merge identical consecutive messages and count duplicates overall.
  const counts = new Map()
  for (const e of entries) {
    e.pattern = e.level + '|' + patternOf(e.line)
    counts.set(e.pattern, (counts.get(e.pattern) || 0) + 1)
  }
  return { entries, counts }
}

export function levelOf(l) {
  const m = l.replace(/^\[[^\]]{1,80}\]\s*/, '')
  if (/exception\b|\berror\b|could not|failed|fatal|null ?reference|XML error|cannot |not found|missing\b/i.test(m) && !/^(Loaded|Loading|Successfully)\b/i.test(m) && !/\b0 errors?\b/i.test(m)) return 'error'
  if (/\bwarn(ing)?\b|deprecated|duplicate|already (exists|defined)|conflict/i.test(m)) return 'warning'
  return 'info'
}

/** "[Mod Name] message" prefix written by RimWorld's BetterLog/Harmony loggers. */
export const prefixOf = (l) => l.match(/^\[([^\]]{1,80})\]/)?.[1] || null

/** Collapse a message to a pattern so 60 "Config error in PJ_KyberCrystalX" lines become one. */
export function patternOf(l) {
  return l
    .replace(/0x[0-9a-f]+/gi, '0x…')
    .replace(/\b\d+(\.\d+)?\b/g, '#')
    .replace(/(named|defName =?|Def|in|for|to) ["']?[A-Za-z_][\w.]*["']?/g, '$1 …')
    .replace(/"[^"]{1,80}"/g, '"…"')
}

/** Guess which mods an entry mentions (by name, packageId or [Mod] prefix). */
export function attributeMods(entry, mods) {
  const hay = (entry.line + '\n' + entry.trace.join('\n')).toLowerCase()
  const hit = []
  const pre = prefixOf(entry.line)?.toLowerCase()
  if (pre) {
    const m = mods.find((x) => x.name?.toLowerCase() === pre || x.packageId?.toLowerCase() === pre)
    if (m && m.kind !== 'core' && m.kind !== 'expansion') return [m.key]
  }
  for (const m of mods) {
    if (m.kind === 'core' || m.kind === 'expansion') continue
    const names = [m.packageId, m.name, m.publishedFileId ? '/' + m.publishedFileId + '/' : null].filter((x) => x && x.length >= 4)
    if (names.some((n) => hay.includes(String(n).toLowerCase()))) hit.push(m.key)
  }
  return hit
}

/**
 * Build a compact, LLM-friendly summary: header, unique errors/warnings with counts,
 * first stack frames, and which mods are mentioned.
 */
export function summarize({ text, mods = [], maxEntries = 80, maxChars = 24000, level = 'warning' } = {}) {
  const { entries, counts } = parseLog(text)
  const rank = { error: 0, warning: 1, info: 2 }
  const want = rank[level] ?? 1
  const seen = new Set()
  const picked = []
  for (const e of entries) {
    if (rank[e.level] > want) continue
    const k = e.pattern
    if (seen.has(k)) continue
    seen.add(k)
    picked.push({ ...e, count: counts.get(k), mods: attributeMods(e, mods) })
  }
  const head = entries.slice(0, 6).map((e) => e.line)
  const byLevel = { error: 0, warning: 0, info: 0 }
  for (const e of entries) byLevel[e.level]++
  const modHits = new Map()
  for (const p of picked) for (const k of p.mods) modHits.set(k, (modHits.get(k) || 0) + (p.level === 'error' ? p.count : 0))
  return { header: head, totals: byLevel, unique: picked.length, entries: picked.slice(0, maxEntries), modHits: [...modHits.entries()].sort((a, b) => b[1] - a[1]), maxChars }
}

export function summaryToText(sum, nameOf = (k) => k, file = '') {
  const out = []
  out.push(`RimWorld Player.log ${file}`)
  out.push(`Totals: ${sum.totals.error} error lines, ${sum.totals.warning} warning lines; ${sum.unique} unique shown`)
  if (sum.header.length) out.push('Header:\n' + sum.header.map((l) => '  ' + l).join('\n'))
  if (sum.modHits.length) out.push('Mods mentioned in errors: ' + sum.modHits.filter(([, n]) => n > 0).slice(0, 20).map(([k, n]) => `${nameOf(k)} (${k}) ×${n}`).join('; '))
  out.push('')
  for (const e of sum.entries) {
    out.push(`${e.level === 'error' ? '✖' : '⚠'}${e.count > 1 ? ' ×' + e.count : ''} ${e.line}`)
    for (const t of e.trace.slice(0, 6)) out.push('    ' + t.trim())
  }
  let s = out.join('\n')
  if (s.length > sum.maxChars) s = s.slice(0, sum.maxChars) + '\n… (truncated)'
  return s
}
