/**
 * Debug logger that writes to ~/.dsh/rimlist/debug.log
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

let logPath = null
let enabled = false

export function initLogger(dataDir, enable = true) {
  logPath = join(dataDir, 'debug.log')
  enabled = enable
}

export async function debugLog(category, ...args) {
  if (!enabled || !logPath) return
  
  const timestamp = new Date().toISOString()
  const message = args.map(a => {
    if (typeof a === 'object') {
      try {
        return JSON.stringify(a, null, 2)
      } catch {
        return String(a)
      }
    }
    return String(a)
  }).join(' ')
  
  const line = `[${timestamp}] [${category}] ${message}\n`
  
  try {
    await appendFile(logPath, line, 'utf-8')
  } catch (err) {
    // Silent fail - don't break functionality if logging fails
    console.error('Debug log write failed:', err.message)
  }
}

export function getLogPath() {
  return logPath
}
