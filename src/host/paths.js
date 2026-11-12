/**
 * RimWorld path discovery (Linux / macOS / Windows) with user overrides.
 * Only reads the filesystem; never writes.
 */
import { access, readdir, readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import path from 'node:path'

const exists = async (p) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

const H = homedir()

/** Steam library roots that may contain `steamapps/`. */
async function steamLibraryRoots() {
  const roots = new Set()
  const bases = platform() === 'win32'
    ? [
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'),
        'C:\\Program Files (x86)\\Steam',
        'C:\\Program Files\\Steam',
        'D:\\Steam',
        'D:\\SteamLibrary',
      ].filter(Boolean)
    : platform() === 'darwin'
      ? [path.join(H, 'Library/Application Support/Steam')]
      : [
          path.join(H, '.local/share/Steam'),
          path.join(H, '.steam/steam'),
          path.join(H, '.steam/root'),
          path.join(H, '.var/app/com.valvesoftware.Steam/.local/share/Steam'),
          path.join(H, 'snap/steam/common/.local/share/Steam'),
        ]
  for (const base of bases) if (await exists(path.join(base, 'steamapps'))) roots.add(base)

  // libraryfolders.vdf lists extra library locations.
  for (const base of [...roots]) {
    const vdf = path.join(base, 'steamapps', 'libraryfolders.vdf')
    if (!(await exists(vdf))) continue
    try {
      const text = await readFile(vdf, 'utf8')
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
        const p = m[1].replace(/\\\\/g, '\\')
        if (await exists(path.join(p, 'steamapps'))) roots.add(p)
      }
    } catch {}
  }
  return [...roots]
}

/**
 * Discover RimWorld locations. Returns candidate values; the caller may
 * override any of them from plugin settings.
 */
export async function discoverPaths() {
  const out = { gameDir: null, configDir: null, workshopDir: null, localModsDir: null, steamRoots: [] }
  const roots = await steamLibraryRoots()
  out.steamRoots = roots
  for (const root of roots) {
    const game = path.join(root, 'steamapps', 'common', 'RimWorld')
    if (!out.gameDir && (await exists(path.join(game, 'Data')))) out.gameDir = game
    const ws = path.join(root, 'steamapps', 'workshop', 'content', '294100')
    if (!out.workshopDir && (await exists(ws))) out.workshopDir = ws
  }
  if (platform() === 'darwin' && !out.gameDir) {
    for (const root of roots) {
      const app = path.join(root, 'steamapps', 'common', 'RimWorld', 'RimWorldMac.app')
      if (await exists(path.join(app, 'Data'))) {
        out.gameDir = app
        break
      }
    }
  }
  if (out.gameDir) out.localModsDir = path.join(out.gameDir, 'Mods')

  const cfgCandidates = platform() === 'win32'
    ? [
        path.join(process.env.USERPROFILE || H, 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, '..', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config'),
      ].filter(Boolean)
    : platform() === 'darwin'
      ? [path.join(H, 'Library/Application Support/RimWorld/Config')]
      : [
          path.join(H, '.config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios/Config'),
          path.join(H, '.var/app/com.valvesoftware.Steam/.config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios/Config'),
        ]
  for (const c of cfgCandidates) {
    if (await exists(c)) {
      out.configDir = path.normalize(c)
      break
    }
  }
  return out
}

/** Read the installed game version from Version.txt, e.g. "1.6.4871 rev598" -> "1.6". */
export async function readGameVersion(gameDir) {
  if (!gameDir) return null
  try {
    let file = path.join(gameDir, 'Version.txt')
    // macOS: gameDir may be the folder containing RimWorldMac.app, or the .app itself.
    if (!(await exists(file)) && (await exists(path.join(gameDir, 'RimWorldMac.app', 'Version.txt')))) file = path.join(gameDir, 'RimWorldMac.app', 'Version.txt')
    const text = (await readFile(file, 'utf8')).trim()
    return { full: text, major: majorVersion(text) }
  } catch {
    return null
  }
}

export function majorVersion(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)/)
  return m ? m[1] + '.' + m[2] : null
}

export { exists }
export async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Default game executable for this platform inside gameDir (used by "launch: direct"). */
export async function findGameExecutable(gameDir) {
  if (!gameDir) return null
  const p = platform()
  const candidates = p === 'win32'
    ? ['RimWorldWin64.exe', 'RimWorldWin.exe']
    : p === 'darwin'
      ? ['RimWorldMac.app', '../RimWorldMac.app']
      : ['RimWorldLinux', 'RimWorldLinux.x86_64', 'RimWorld']
  for (const c of candidates) {
    const f = path.join(gameDir, c)
    if (await exists(f)) return path.normalize(f)
  }
  if (p === 'darwin' && gameDir.endsWith('.app')) return gameDir
  return null
}
