/**
 * Find / stop a running RimWorld process.
 *   Linux  – scan /proc/<pid>/exe (or cmdline) for the game executable inside gameDir.
 *   Windows – tasklist / taskkill on RimWorldWin64.exe.
 *   macOS  – pgrep / kill on RimWorldMac.
 */
import { execFile } from 'node:child_process'
import { readdir, readlink, readFile, realpath } from 'node:fs/promises'
import { platform } from 'node:os'
import path from 'node:path'

const LINUX_NAMES = new Set(['RimWorld', 'RimWorldLinux', 'RimWorldLinux.x86_64'])
const WIN_NAMES = ['RimWorldWin64.exe', 'RimWorldWin.exe']

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || ''))))

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

async function linuxProcs(gameDir) {
  let root = null
  if (gameDir) root = await realpath(gameDir).catch(() => path.resolve(gameDir))
  const out = []
  for (const d of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(d)) continue
    const pid = Number(d)
    if (pid === process.pid) continue
    let exe = await readlink(`/proc/${d}/exe`).catch(() => '')
    exe = exe.replace(/ \(deleted\)$/, '')
    let hit = exe && LINUX_NAMES.has(path.basename(exe)) && (!root || exe.startsWith(root + path.sep))
    if (!hit && !exe) {
      // exe not readable (different user / sandbox): fall back to argv[0]
      const cmd = (await readFile(`/proc/${d}/cmdline`, 'utf8').catch(() => '')).split('\0')[0]
      hit = !!cmd && LINUX_NAMES.has(path.basename(cmd)) && (!root || path.resolve(cmd).startsWith(root + path.sep))
      exe = cmd
    }
    if (hit) out.push({ pid, exe })
  }
  return out
}

async function winProcs() {
  const out = []
  for (const name of WIN_NAMES) {
    const txt = await run('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'])
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/)
      if (m) out.push({ pid: Number(m[2]), exe: m[1] })
    }
  }
  return out
}

async function macProcs() {
  const txt = await run('pgrep', ['-fl', 'RimWorldMac'])
  return txt.split('\n').map((l) => l.match(/^(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), exe: m[2] }))
}

/** Running game processes: [{pid, exe}]. */
export async function findGameProcesses(gameDir) {
  const p = platform()
  if (p === 'win32') return winProcs()
  if (p === 'darwin') return macProcs()
  return linuxProcs(gameDir)
}

export async function gameStatus(gameDir) {
  const procs = await findGameProcesses(gameDir)
  return { running: procs.length > 0, processes: procs }
}

/**
 * Stop the game. Asks politely (SIGTERM / taskkill) first; after `waitMs` force-kills
 * survivors when force=true (or right away when force=true and waitMs=0).
 */
export async function stopGame(gameDir, { force = false, waitMs = 5000 } = {}) {
  const procs = await findGameProcesses(gameDir)
  if (!procs.length) return { stopped: false, running: false, message: 'RimWorld is not running' }
  const win = platform() === 'win32'
  const kill = async (pid, hard) => {
    if (win) await run('taskkill', ['/PID', String(pid), ...(hard ? ['/F'] : [])])
    else {
      try {
        process.kill(pid, hard ? 'SIGKILL' : 'SIGTERM')
      } catch {}
    }
  }
  for (const p of procs) await kill(p.pid, false)
  const deadline = Date.now() + Math.max(0, waitMs)
  let left = procs
  while (Date.now() < deadline) {
    left = procs.filter((p) => alive(p.pid))
    if (!left.length) break
    await new Promise((r) => setTimeout(r, 250))
  }
  left = procs.filter((p) => alive(p.pid))
  let forced = false
  if (left.length && force) {
    forced = true
    for (const p of left) await kill(p.pid, true)
    await new Promise((r) => setTimeout(r, 500))
    left = procs.filter((p) => alive(p.pid))
  }
  return { stopped: left.length === 0, forced, pids: procs.map((p) => p.pid), stillRunning: left.map((p) => p.pid) }
}
