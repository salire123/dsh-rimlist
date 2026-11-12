/**
 * Start RimWorld. Modes:
 *   steam  – ask Steam to run app 294100 (steam://rungameid/294100). Works on all platforms.
 *   direct – run the game executable found in gameDir (RimWorldWin64.exe / RimWorldLinux / RimWorldMac.app).
 *   custom – run any program with arguments (e.g. a Proton wrapper, a script, `flatpak run …`).
 * Extra game arguments (e.g. -logfile, -savedatafolder=…) are appended for direct/custom,
 * and passed through Steam's applaunch for steam mode when a steam executable is configured.
 * The child is detached so it outlives DSH.
 */
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import path from 'node:path'
import { findGameExecutable, exists } from './paths.js'

export const RIMWORLD_APPID = '294100'

/** Split a command line into argv, honouring "double" and 'single' quotes. */
export function splitArgs(line) {
  const out = []
  let cur = ''
  let quote = null
  let has = false
  for (const ch of String(line || '')) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else cur += ch
  }
  if (cur || has) out.push(cur)
  return out
}

const openerFor = (target) => {
  const p = platform()
  if (p === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', target] }
  if (p === 'darwin') return { cmd: 'open', args: [target] }
  return { cmd: 'xdg-open', args: [target] }
}

/** Resolve the program + args that `launchGame` would run (exported for the UI preview & tests). */
export async function resolveLaunch(cfg = {}, gameDir, { extraArgs = [] } = {}) {
  const mode = cfg.mode || 'steam'
  const extra = [...splitArgs(cfg.args), ...extraArgs]
  if (mode === 'steam') {
    if (cfg.steamPath) return { mode, cmd: cfg.steamPath, args: ['-applaunch', RIMWORLD_APPID, ...extra] }
    // steam://run/<appid>//<args>/ passes launch arguments through the URL handler (Steam may ask to confirm).
    if (extra.length) return { mode, ...openerFor(`steam://run/${RIMWORLD_APPID}//${encodeURIComponent(extra.join(' '))}/`) }
    return { mode, ...openerFor('steam://rungameid/' + RIMWORLD_APPID) }
  }
  if (mode === 'direct') {
    const exe = cfg.executable || (await findGameExecutable(gameDir))
    if (!exe) throw new Error('game executable not found; set it in Settings')
    if (platform() === 'darwin' && exe.endsWith('.app')) return { mode, cmd: 'open', args: ['-a', exe, ...(extra.length ? ['--args', ...extra] : [])], cwd: path.dirname(exe) }
    return { mode, cmd: exe, args: extra, cwd: path.dirname(exe) }
  }
  if (mode === 'custom') {
    const parts = splitArgs(cfg.command)
    if (!parts.length) throw new Error('custom launch command is empty; set it in Settings')
    return { mode, cmd: parts[0], args: [...parts.slice(1), ...extra], cwd: gameDir || undefined }
  }
  throw new Error('unknown launch mode: ' + mode)
}

/** Open a Steam workshop page in the Steam client, or (browser=true) in the default web browser. */
export async function openWorkshopPage(pfid, { browser = false } = {}) {
  const id = String(pfid || '').replace(/\D/g, '')
  if (!id) throw new Error('workshop id required')
  const target = browser ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}` : `steam://url/CommunityFilePage/${id}`
  const o = openerFor(target)
  await new Promise((resolve, reject) => {
    const child = spawn(o.cmd, o.args, { detached: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
  return { opened: target, web: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}` }
}

/** Subscribe to a Steam workshop item. Opens the Steam client subscribe dialog. */
export async function subscribeSteamWorkshop(pfid) {
  const id = String(pfid || '').replace(/\D/g, '')
  if (!id) throw new Error('workshop id required')
  // Steam URL protocol to open subscribe dialog
  const target = `steam://url/CommunityFilePage/${id}`
  const o = openerFor(target)
  await new Promise((resolve, reject) => {
    const child = spawn(o.cmd, o.args, { detached: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
  return { opened: target, action: 'subscribe', id }
}

/** Unsubscribe from a Steam workshop item. Opens Steam with the item page where user can unsubscribe. */
export async function unsubscribeSteamWorkshop(pfid) {
  const id = String(pfid || '').replace(/\D/g, '')
  if (!id) throw new Error('workshop id required')
  // Note: Steam doesn't have a direct unsubscribe:// protocol, so we open the workshop page
  // where the user can click the unsubscribe button
  const target = `steam://url/CommunityFilePage/${id}`
  const o = openerFor(target)
  await new Promise((resolve, reject) => {
    const child = spawn(o.cmd, o.args, { detached: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
  return { opened: target, action: 'unsubscribe', id, note: 'Opens Steam workshop page where you can unsubscribe' }
}

export async function launchGame(cfg, gameDir, opts = {}) {
  const plan = await resolveLaunch(cfg, gameDir, opts)
  if (plan.cwd && !(await exists(plan.cwd))) delete plan.cwd
  await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(plan.cmd, plan.args, { cwd: plan.cwd, detached: true, stdio: 'ignore', windowsHide: false, shell: false })
    } catch (e) {
      return reject(e)
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
  return { started: true, mode: plan.mode, command: [plan.cmd, ...plan.args].join(' '), note: plan.note }
}
