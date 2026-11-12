/**
 * dsh-rimlist: RimWorld mod manager for DeepSeek Harness (host plugin).
 *
 * - Scans Core/DLC, local Mods/ and Steam Workshop mods.
 * - Sorts with About.xml rules + RimSort Community Rules + Steam DB + user rules.
 * - Diagnoses missing deps / version mismatches / incompatibilities.
 * - Named mod lists: save, import (paste / URL), export, diff, apply.
 * - Writes ModsConfig.xml with timestamped backups.
 * - Browser API: POST /api/rimlist  { method, args }
 * - Agent tools: rimlist_* (see TOOLS below).
 *
 * Data lives in $DSH_HOME/rimlist (not per-workspace: the game install is global).
 */
import path from 'node:path'
import { homedir } from 'node:os'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createService } from './src/host/service.js'
import { TYPES as MOD_TAG_TYPES, FEATURE_TAGS as MOD_FEATURE_TAGS } from './src/host/classify.js'
import { loadSkillDefinition, SKILL_FILE } from './src/host/skill.js'
import { installToolGate } from './src/host/toolgate.js'

export const name = 'dsh-rimlist'
export const inject = ['tools']

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  const dataDir = path.join(dshHome, 'rimlist')
  const log = (m) => console.log('dsh-rimlist: ' + m)
  const service = createService({ dataDir, log })
  service.init().then(
    () => log(`ready: ${service.state.mods.length} mods, ${service.activeKeys().length} active, game ${service.state.game?.full || 'not found'}`),
    (e) => log('init failed: ' + (e && e.message)),
  )

  // ---- HTTP ----
  const MAX_BODY = 4 * 1024 * 1024
  const sendJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  const sameOrigin = (req) => {
    const origin = req.headers?.origin
    const host = req.headers?.host
    if (!origin || !host) return true
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  const httpHandler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      // Preview images: GET /api/rimlist/preview?id=<packageId>
      if (req.method === 'GET' && url.pathname.endsWith('/preview')) {
        const p = await service.dispatch('previewPath', { packageId: url.searchParams.get('id') || '' })
        if (!p) return sendJson(res, 404, { error: 'no preview' })
        const s = await stat(p)
        res.writeHead(200, { 'content-type': p.endsWith('.jpg') ? 'image/jpeg' : 'image/png', 'content-length': s.size, 'cache-control': 'private, max-age=3600' })
        createReadStream(p).pipe(res)
        return
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request denied' })
      const ct = String(req.headers['content-type'] || '').toLowerCase()
      if (!ct.startsWith('application/json')) return sendJson(res, 415, { error: 'Expected application/json' })
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) return sendJson(res, 413, { error: 'Request body too large' })
        chunks.push(chunk)
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      const method = typeof body.method === 'string' ? body.method : 'snapshot'
      const args = isObj(body.args) ? body.args : {}
      const result = await service.dispatch(method, args)
      return sendJson(res, 200, { ok: true, result })
    } catch (err) {
      const status = err instanceof SyntaxError ? 400 : 500
      return sendJson(res, status, { ok: false, error: String((err && err.message) || err) })
    }
  }

  const routeState = { registered: false, timer: null, dispose: null, disposed: false, attempts: 0 }
  const registerRoute = () => {
    if (routeState.registered || routeState.disposed) return
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    try {
      const dispose = webServer.register({ kind: 'prefix', path: '/api/rimlist', handler: httpHandler })
      routeState.dispose = typeof dispose === 'function' ? dispose : null
      routeState.registered = true
      log('/api/rimlist route registered')
    } catch (err) {
      log('route registration failed: ' + ((err && err.message) || err))
    }
  }
  registerRoute()
  if (!routeState.registered) {
    const timer = ctx.get('timer')
    if (timer) {
      routeState.timer = timer.interval(() => {
        routeState.attempts++
        registerRoute()
        if (routeState.registered || routeState.attempts >= 40) {
          if (routeState.timer) routeState.timer()
          routeState.timer = null
        }
      }, 500)
    }
  }

  // ---- AI tools ----
  const textOut = (fn) => ({
    schema: { type: 'object', additionalProperties: true },
    render: (args, value) => [{ type: 'text', text: fn(value) }],
  })
  const run = async (method, args) => {
    try {
      // JSON round-trip: drops undefined / Sets / Maps so the host gets lossless JSON.
      return JSON.parse(JSON.stringify({ ok: true, ...(await wrapResult(await service.dispatch(method, args))) }))
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  }
  const wrapResult = async (r) => (isObj(r) ? r : { result: r })
  const nameOf = (k) => service.state.catalog.get(k)?.name || k
  const fmtIssues = (d) => {
    if (!d || !d.issues) return ''
    const lines = [`${d.counts.error} errors, ${d.counts.warning} warnings, ${d.counts.info} info`]
    for (const i of d.issues.slice(0, 60)) lines.push(`${i.level === 'error' ? '✖' : i.level === 'warning' ? '⚠' : 'ℹ'} [${i.code}] ${i.modName} (${i.mod}): ${i.message}${i.steam?.url ? ' → ' + i.steam.url : ''}`)
    if (d.issues.length > 60) lines.push(`… ${d.issues.length - 60} more`)
    return lines.join('\n')
  }

  const tools = [
    {
      name: 'rimlist_status',
      description: 'RimWorld mod manager overview: game version, paths, installed/active mod counts, rule database status, saved lists and a diagnostics summary of the current load order.',
      parameters: { type: 'object', properties: {} },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const s = v
        const lines = [
          `RimWorld ${s.game?.full || 'NOT FOUND'} · ${s.mods.length} mods installed (${s.mods.filter((m) => m.source === 'workshop').length} workshop, ${s.mods.filter((m) => m.source === 'local').length} local) · ${s.active.length} active`,
          `ModsConfig: ${s.modsConfigPath || '(none)'}`,
          `Rules: community ${s.rules.community.rules} rules${s.rules.community.error ? ' (error: ' + s.rules.community.error + ')' : ''}; steam DB ${s.rules.steam.entries} entries; NoVersionWarning ${s.rules.noVersionWarning.ids} ids; user ${s.rules.user.rules} rules`,
          `Lists: ${s.lists.map((l) => `${l.name} [${l.id}] (${l.count})`).join(', ') || 'none'}`,
          'Diagnostics: ' + fmtIssues(s.diagnostics),
        ]
        return lines.join('\n')
      }),
      async execute() {
        return run('snapshot', {})
      },
    },
    {
      name: 'rimlist_active',
      description: 'Return the current RimWorld load order (active mods, in order) with packageIds and names.',
      parameters: { type: 'object', properties: {} },
      output: textOut((v) => (v.ok ? v.active.map((k, i) => `${i + 1}. ${nameOf(k)} (${k})`).join('\n') : 'Error: ' + v.error)),
      async execute() {
        const s = await service.dispatch('snapshot', {})
        return { ok: true, active: s.active }
      },
    },
    {
      name: 'rimlist_search',
      description: 'Search installed RimWorld mods by name, packageId, author or workshop id, and/or by classification: type (primary or secondary), feature tags / Chinese display tags (all must match), minimum confidence. Optionally filter active/inactive. Tag filters use the cached classification (unscanned mods are classified on demand).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text (case-insensitive); may be empty when filtering by tag/type' },
          active: { type: 'boolean', description: 'true = only active mods, false = only inactive; omit for all' },
          limit: { type: 'number', description: 'Max results (default 50)' },
          type: { type: 'string', enum: MOD_TAG_TYPES, description: 'Mod type filter; matches primary or secondary type' },
          primaryOnly: { type: 'boolean', description: 'With type: only match the primary type' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Feature tags (e.g. menu, storage, joblogic) or Chinese display tags (e.g. 菜单, 生活改善); all must match' },
          minConfidence: { type: 'number', description: 'Minimum classification confidence 0-1' },
        },
      },
      output: textOut((v) => (v.ok ? (v.result.length ? v.result.map((m) => `${m.active ? '●' : '○'} ${m.name} (${m.key})${m.author ? ' by ' + m.author : ''} [${m.supportedVersions.join('/')}]${m.publishedFileId ? ' ws:' + m.publishedFileId : ''}${m.primaryType ? ` · ${m.primaryType}${m.secondaryTypes?.length ? '+' + m.secondaryTypes.join('/') : ''} ${Math.round(m.confidence * 100)}% [${(m.tags || []).join(', ')}]` : ''}`).join('\n') : 'No matches') : 'Error: ' + v.error)),
      async execute(args) {
        return run('search', args)
      },
    },
    {
      name: 'rimlist_mod',
      description: 'Full details of one installed mod: metadata, dependencies, load rules from About.xml and rule databases, Steam DB info.',
      parameters: { type: 'object', properties: { packageId: { type: 'string' } }, required: ['packageId'] },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const m = v.result !== undefined ? v.result : v.packageId ? v : null
        if (!m) return 'Not installed'
        return [
          `${m.name} (${m.packageId}) by ${m.author || '?'} · ${m.kind}/${m.source} · versions ${m.supportedVersions.join(', ') || 'none'}${m.nvw ? ' · NoVersionWarning-covered' : ''}`,
          `Path: ${m.path}`,
          m.publishedFileId ? `Workshop: https://steamcommunity.com/sharedfiles/filedetails/?id=${m.publishedFileId}` : '',
          m.dependsOn.length ? 'Depends on: ' + m.dependsOn.map((d) => `${d.name} (${d.packageId})`).join(', ') : '',
          m.loadAfter.length ? 'About loadAfter: ' + m.loadAfter.join(', ') : '',
          m.loadBefore.length ? 'About loadBefore: ' + m.loadBefore.join(', ') : '',
          m.incompatibleWith.length ? 'About incompatibleWith: ' + m.incompatibleWith.join(', ') : '',
          Object.keys(m.rules.loadAfter).length ? 'Rules loadAfter: ' + Object.entries(m.rules.loadAfter).map(([k, i]) => `${k}[${i.source}]`).join(', ') : '',
          Object.keys(m.rules.loadBefore).length ? 'Rules loadBefore: ' + Object.entries(m.rules.loadBefore).map(([k, i]) => `${k}[${i.source}]`).join(', ') : '',
          m.rules.loadTop ? 'Rules: loadTop' : '',
          m.rules.loadBottom ? 'Rules: loadBottom' : '',
          m.description ? 'Description: ' + m.description.replace(/\s+/g, ' ').slice(0, 600) : '',
        ].filter(Boolean).join('\n')
      }),
      async execute(args) {
        return run('mod', args)
      },
    },
    {
      name: 'rimlist_diagnose',
      description: 'Check the current (or a given) RimWorld load order for problems: missing/inactive dependencies, version mismatches, incompatibilities, order violations against About.xml and community/user rules.',
      parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Optional packageId list to check instead of the current active list' } } },
      output: textOut((v) => (v.ok ? fmtIssues(v) : 'Error: ' + v.error)),
      async execute(args) {
        return run('diagnose', args)
      },
    },
    {
      name: 'rimlist_sort',
      description: 'Compute a sorted load order (Core → DLC → frameworks → mods → patches/loadBottom) using About.xml + community + user rules. With save=true the result is written to ModsConfig.xml (a backup is made first).',
      parameters: {
        type: 'object',
        properties: {
          save: { type: 'boolean', description: 'Write the sorted order to ModsConfig.xml (default false = preview only)' },
          tieBreak: { type: 'string', enum: ['name', 'current', 'rimsort'], description: 'name = priority-aware sort, alphabetical tie-break (default); current = keep current relative order; rimsort = exact RimSort Topological algorithm (level-by-level, alphabetical per level)' },
        },
      },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const lines = [`${v.saved ? 'Saved.' : 'Preview.'} Moved ${v.moved} of ${v.order.length}. Issues before: ${v.before.error}E/${v.before.warning}W → after: ${v.after.error}E/${v.after.warning}W`]
        for (const b of v.broken) lines.push(`Cycle broken: ${b.cycle.join(' ; ')} (dropped ${b.dropped.source} rule ${b.dropped.from} → ${b.dropped.to})`)
        for (const c of v.crossTierViolations) lines.push(`Unresolvable tier conflict: ${nameOf(c.from)} should load before ${nameOf(c.to)} (${c.source})`)
        lines.push(...v.order.map((k, i) => `${i + 1}. ${nameOf(k)} (${k})`))
        return lines.join('\n')
      }),
      async execute(args) {
        return run('sort', args)
      },
    },
    {
      name: 'rimlist_explain',
      description: 'Explain why a mod sits where it does: every ordering constraint touching it and which source (About.xml, dependency, community rule, user rule) created it.',
      parameters: { type: 'object', properties: { packageId: { type: 'string' } }, required: ['packageId'] },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const lines = [`${v.name} (${v.packageId}) · position ${v.position >= 0 ? v.position + 1 : 'inactive'}${v.rules.loadTop ? ' · loadTop' : ''}${v.rules.loadBottom ? ' · loadBottom' : ''}`]
        if (v.mustLoadAfter.length) lines.push('Must load AFTER: ' + v.mustLoadAfter.map((e) => `${e.name} [${e.source}${e.comment ? ': ' + e.comment : ''}]`).join('; '))
        if (v.mustLoadBefore.length) lines.push('Must load BEFORE: ' + v.mustLoadBefore.map((e) => `${e.name} [${e.source}${e.comment ? ': ' + e.comment : ''}]`).join('; '))
        if (lines.length === 1) lines.push('No ordering constraints; keeps its current relative position.')
        return lines.join('\n')
      }),
      async execute(args) {
        return run('explain', args)
      },
    },
    {
      name: 'rimlist_set_active',
      description: 'Modify the RimWorld active mod list and write ModsConfig.xml (backup first). action=activate appends/ inserts, deactivate removes, move repositions one mod, replace sets the whole ordered list.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['activate', 'deactivate', 'move', 'replace'] },
          ids: { type: 'array', items: { type: 'string' }, description: 'packageIds (activate/deactivate/replace)' },
          id: { type: 'string', description: 'packageId to move' },
          to: { type: 'number', description: 'target 0-based index for move / insert position for activate' },
        },
        required: ['action'],
      },
      output: textOut((v) => (v.ok ? `Done. ${v.active.length} mods active.` : 'Error: ' + v.error)),
      async execute(args) {
        const a = args.action
        if (a === 'activate') return run('activate', { ids: args.ids || [], position: args.to })
        if (a === 'deactivate') return run('deactivate', { ids: args.ids || [] })
        if (a === 'move') return run('move', { id: args.id, to: args.to })
        if (a === 'replace') return run('setActive', { ids: args.ids || [] })
        return { ok: false, error: 'unknown action' }
      },
    },
    {
      name: 'rimlist_rule',
      description: 'Add or remove a user-defined sorting rule (persisted, overrides community rules; use when the community database is wrong or missing for new/niche mods). kind: loadAfter | loadBefore | incompatibleWith | ignoreIncompatible (need target) | loadTop | loadBottom. ignoreIncompatible suppresses a reported incompatibility between two mods that actually work together.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove'] },
          packageId: { type: 'string' },
          kind: { type: 'string', enum: ['loadAfter', 'loadBefore', 'incompatibleWith', 'ignoreIncompatible', 'loadTop', 'loadBottom'] },
          target: { type: 'string', description: 'Other packageId (not for loadTop/loadBottom)' },
          comment: { type: 'string', description: 'Why this rule exists' },
        },
        required: ['action', 'packageId', 'kind'],
      },
      output: textOut((v) => (v.ok ? 'Rule saved. Effective rules: ' + JSON.stringify(v.rules) : 'Error: ' + v.error)),
      async execute(args) {
        return run(args.action === 'remove' ? 'removeRule' : 'addRule', args)
      },
    },
    {
      name: 'rimlist_lists',
      description: 'Manage saved mod lists. Each saved mod remembers where it came from (workshop id, or git url + branch for git mods). action=list shows saved lists; save stores the current load order (or given ids) under a name; apply activates a saved list (mode replace|merge; mods not on disk are skipped and reported); install_missing gets the mods of a list that are not installed — git mods are cloned into the local Mods folder, workshop mods open their Steam page to subscribe (then rescan + apply again); delete removes it; compare diffs a saved list against the current load order; export returns text in a format (rimlist|modsconfig|ids|markdown).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save', 'apply', 'install_missing', 'delete', 'compare', 'export', 'get'] },
          id: { type: 'string', description: 'List id (apply/delete/compare/export/get, or save to overwrite)' },
          name: { type: 'string' },
          description: { type: 'string' },
          ids: { type: 'array', items: { type: 'string' }, description: 'save: packageIds to store instead of the current active list' },
          mode: { type: 'string', enum: ['replace', 'merge'] },
          format: { type: 'string', enum: ['rimlist', 'modsconfig', 'ids', 'markdown'] },
        },
        required: ['action'],
      },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        if (Array.isArray(v.result)) return v.result.length ? v.result.map((l) => `${l.name} [${l.id}] · ${l.count} mods · RW ${l.gameVersion || '?'}${l.author ? ' · ' + l.author : ''} · ${new Date(l.updatedAt).toISOString().slice(0, 10)}`).join('\n') : 'No saved lists'
        if (v.text) return `${v.filename}:\n${v.text}`
        if (v.added) return `vs ${v.list.name}: +${v.added.length} added, −${v.removed.length} removed, ${v.reordered.length} reordered, ${v.same} same\nAdded: ${v.added.map((m) => m.name + (m.installed ? '' : ' (not installed)')).join(', ') || '-'}\nRemoved: ${v.removed.map((m) => m.name).join(', ') || '-'}`
        if (v.cloned) {
          const f = (a, fn) => a.map(fn).join(', ')
          return [`"${v.list.name}": ${v.missing} not installed`,
            v.cloned.length && `Cloned from git (${v.cloned.length}): ${f(v.cloned, (m) => m.name + (m.warning ? ' — ' + m.warning : ''))}`,
            v.opened.length && `Opened Steam page to subscribe (${v.opened.length}): ${f(v.opened, (m) => m.name)}`,
            v.failed.length && `Failed (${v.failed.length}): ${f(v.failed, (m) => m.name + ' — ' + m.error)}`,
            v.manual.length && `No source known, install by hand (${v.manual.length}): ${f(v.manual, (m) => m.name)}`,
            v.missing ? 'After subscribing, run rimlist_rescan and apply the list again.' : 'Nothing to install.'].filter(Boolean).join('\n')
        }
        if (v.missing) return `Applied. ${v.active.length} active. Missing (not installed): ${v.missing.map((m) => (m.name || m.packageId) + (m.git ? ' [git ' + m.git.url + ']' : m.publishedFileId ? ' [workshop ' + m.publishedFileId + ']' : '')).join(', ') || 'none'}${v.missing.length ? '\nUse action=install_missing to clone git mods / open Steam pages.' : ''}`
        if (v.mods) return `Saved "${v.name}" [${v.id}] with ${v.mods.length} mods`
        return JSON.stringify(v.result ?? v).slice(0, 2000)
      }),
      async execute(args) {
        switch (args.action) {
          case 'list': return run('lists', {})
          case 'get': return run('getList', { id: args.id })
          case 'save': return run('saveList', { id: args.id, name: args.name, description: args.description, mods: args.ids })
          case 'apply': return run('applyList', { id: args.id, mode: args.mode })
          case 'install_missing': return run('installMissing', { id: args.id })
          case 'delete': return run('deleteList', { id: args.id })
          case 'compare': return run('compareList', { id: args.id })
          case 'export': return run('exportList', { id: args.id, format: args.format })
          default: return { ok: false, error: 'unknown action' }
        }
      },
    },
    {
      name: 'rimlist_import',
      description: "Import another player's mod list from pasted text (dsh-rimlist JSON, ModsConfig.xml, plain packageId list, markdown table, workshop URLs) or from a URL (raw GitHub, Gist, rentry, pastebin). Saves it as a named list and reports missing mods and the diff against the current load order.",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Pasted list content' },
          url: { type: 'string', description: 'URL to fetch instead of text' },
          name: { type: 'string', description: 'Name for the saved list' },
          save: { type: 'boolean', description: 'Save as a list (default true)' },
        },
      },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const lines = [`Imported "${v.name}" · ${v.mods.length} mods${v.list ? ' · saved as [' + v.list.id + ']' : ''}`]
        lines.push(`Diff vs current: +${v.diff.added.length} / −${v.diff.removed.length} / ${v.diff.reordered.length} reordered`)
        if (v.missing.length) lines.push(`Not installed (${v.missing.length}): ` + v.missing.map((m) => `${m.name || m.packageId}${m.git ? ' git ' + m.git.url : m.publishedFileId ? ' https://steamcommunity.com/sharedfiles/filedetails/?id=' + m.publishedFileId : ''}`).join('; '))
        if (v.missing.length && v.list) lines.push(`Run rimlist_lists action=install_missing id=${v.list.id} to clone git mods and open Steam pages for the rest.`)
        if (v.unresolved.length) lines.push(`Unresolved workshop ids (${v.unresolved.length}): ` + v.unresolved.map((m) => m.publishedFileId).join(', '))
        return lines.join('\n')
      }),
      async execute(args) {
        if (args.url) return run('importUrl', args)
        if (args.text) return run('importText', args)
        return { ok: false, error: 'text or url required' }
      },
    },
    {
      name: 'rimlist_saves',
      description: 'RimWorld save files (*.rws) and the mod list stored in each one. action=list shows saves (newest first: name, date, game version, mod count; "folder##name" = save folder); action=show lists the mods of one save (name) with which are not installed and the diff against the current load order; action=import saves that mod list as a named list (listName optional) — then use rimlist_lists apply / install_missing. Read-only on the save file itself.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show', 'import'] },
          name: { type: 'string', description: 'show/import: save file name, e.g. "Colony1.rws" (extension optional)' },
          listName: { type: 'string', description: 'import: name for the saved list' },
          limit: { type: 'number', description: 'list: max saves to show (default 40)' },
        },
        required: ['action'],
      },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const d = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
        if (v.saves) {
          if (!v.exists) return `Saves folder not found: ${v.dir || '(unknown)'} — set savesDir in settings`
          const lim = v.limit || 40
          return [`${v.saves.length} saves in ${v.dir}`, ...v.saves.slice(0, lim).map((s) => `${d(s.mtime)}  ${s.name}  · RW ${s.gameVersion || '?'} · ${s.error ? 'ERROR ' + s.error : s.modCount + ' mods'} · ${(s.size / 1048576).toFixed(1)} MB`), v.saves.length > lim ? `… ${v.saves.length - lim} more` : ''].filter(Boolean).join('\n')
        }
        if (v.list || v.diff && v.unresolved) {
          const lines = [`Imported "${v.name}" · ${v.mods.length} mods${v.list ? ' · saved as [' + v.list.id + ']' : ''}`, `Diff vs current: +${v.diff.added.length} / −${v.diff.removed.length} / ${v.diff.reordered.length} reordered`]
          if (v.missing.length) lines.push(`Not installed (${v.missing.length}): ` + v.missing.map((m) => `${m.name || m.packageId}${m.publishedFileId ? ' ws:' + m.publishedFileId : ''}`).join('; '))
          if (v.list) lines.push(`Apply with rimlist_lists action=apply id=${v.list.id}${v.missing.length ? '; get missing mods with action=install_missing' : ''}.`)
          return lines.join('\n')
        }
        const lines = [`${v.name} · ${d(v.mtime)} · RimWorld ${v.gameVersion || '?'} · ${v.mods.length} mods · ${v.sameAsCurrent ? 'same as current load order' : `vs current: +${v.diff.added.length} / −${v.diff.removed.length} / ${v.diff.reordered.length} reordered`}`]
        if (v.missing.length) lines.push(`Not installed (${v.missing.length}): ` + v.missing.map((m) => `${m.name || m.packageId} (${m.packageId})${m.publishedFileId ? ' ws:' + m.publishedFileId : ''}`).join('; '))
        lines.push(...v.mods.map((m, i) => `${i + 1}. ${m.name || m.packageId} (${m.packageId})${m.installed ? '' : ' [not installed]'}`))
        return lines.join('\n')
      }),
      async execute(args) {
        if (args.action === 'show') return run('saveDetail', { name: args.name })
        if (args.action === 'import') return run('importSave', { name: args.name, listName: args.listName })
        const r = await run('saves', {})
        if (r.ok) r.limit = args.limit
        return r
      },
    },
    {
      name: 'rimlist_rescan',
      description: 'Rescan RimWorld mod folders (after subscribing/unsubscribing workshop mods) and optionally force-refresh the rule databases.',
      parameters: { type: 'object', properties: { refreshRules: { type: 'boolean' } } },
      output: textOut((v) => (v.ok ? `Rescanned: ${v.count} mods${v.rules ? '; rules: community ' + v.rules.community.rules + ', steam ' + v.rules.steam.entries + ', nvw ' + v.rules.noVersionWarning.ids : ''}` : 'Error: ' + v.error)),
      async execute(args) {
        const r = await run('rescan', {})
        if (r.ok && args.refreshRules) r.rules = await service.dispatch('refreshRules', { force: true })
        return r
      },
    },
    {
      name: 'rimlist_launch',
      description: 'Start RimWorld using the launch method configured in RimList settings (Steam, the game executable, or a custom command). Save the load order first if you changed it. action=preview shows the command without running it. quicktest=true adds -quicktest (skip the main menu and generate a small test map) — a fast way to check that the mod list loads into a game.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['launch', 'preview'] }, quicktest: { type: 'boolean' } } },
      output: textOut((v) => (!v.ok ? 'Error: ' + v.error : v.started ? 'RimWorld started: ' + v.command : `Launch command (${v.platform}): ${v.command || 'n/a'}${v.error ? ' — ' + v.error : ''}`)),
      execute: (args) => run(args.action === 'preview' ? 'launchPreview' : 'launch', args.quicktest ? { quicktest: true } : {}),
    },
    {
      name: 'rimlist_game',
      description: 'Check whether RimWorld is running (action=status) or stop it (action=stop). stop sends a normal close signal first; force=true kills the process if it has not exited within waitMs (default 5000). Unsaved game progress is lost when stopping.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'stop'] }, force: { type: 'boolean' }, waitMs: { type: 'number' } }, required: ['action'] },
      output: textOut((v) =>
        !v.ok ? 'Error: ' + v.error
          : 'running' in v && !('stopped' in v) ? (v.running ? 'RimWorld is running: ' + v.processes.map((p) => `pid ${p.pid} (${p.exe})`).join(', ') : 'RimWorld is not running')
            : v.stopped ? `RimWorld stopped (pid ${v.pids.join(', ')})${v.forced ? ' — force-killed' : ''}`
              : v.running === false ? 'RimWorld is not running'
                : `RimWorld is still running (pid ${v.stillRunning.join(', ')}); retry with force=true`,
      ),
      execute: (args) => run(args.action === 'stop' ? 'stopGame' : 'gameStatus', args.action === 'stop' ? { force: !!args.force, ...(args.waitMs != null ? { waitMs: args.waitMs } : {}) } : {}),
    },
    {
      name: 'rimlist_mod_updates',
      description: 'Mod update log. action=recent lists mods updated in the last N days (Steam timeupdated for workshop mods, scan history for local/git) plus workshop items with a pending update; action=changelog shows one mod\'s Steam Workshop changelog or git commit log (needs packageId). Use it when the game broke after mods updated.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['recent', 'changelog'] },
          packageId: { type: 'string' },
          days: { type: 'number', description: 'recent: look-back window in days (default 14)' },
          onlyActive: { type: 'boolean', description: 'recent: only active mods (default true)' },
        },
      },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const d = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
        if (v.recent) {
          const lines = [`${v.recent.length} updated mods${v.pending.length ? `, ${v.pending.length} pending workshop updates` : ''}`]
          for (const r of v.recent.slice(0, 80)) lines.push(`${d(r.time)}  ${r.name} (${r.key})${r.active ? '' : ' [inactive]'}${r.hasBackup ? ' [backup]' : ''}${r.source !== 'workshop' ? ' [' + r.source + ']' : ''}`)
          for (const p of v.pending) lines.push(`PENDING ${p.name} (${p.key}) → ${p.latestAt ? d(p.latestAt) : '?'}`)
          return lines.join('\n')
        }
        if (v.kind === 'none') return 'No update log: not a workshop or git mod.'
        const lines = [v.kind === 'git' ? `git ${v.git?.remote || ''} @ ${v.git?.head || ''}` : `Steam changelog ${v.url}`]
        for (const e of v.entries.slice(0, 30)) lines.push(`${d(e.time * 1000)}${e.current ? ' [installed]' : e.newer ? ' [newer]' : ''}  ${e.hash ? e.hash + ' ' : ''}${e.text.replace(/\n+/g, ' / ').slice(0, 400)}`)
        return lines.join('\n')
      }),
      execute: (args) => (args.action === 'changelog' ? run('modChangelog', args) : run('modUpdates', { days: args.days ?? 14, onlyActive: args.onlyActive !== false })),
    },
    {
      name: 'rimlist_mod_backup',
      description: 'Snapshot backups of mod folders (Steam Workshop cannot roll back). action=list shows snapshots (optionally for one packageId); backup snapshots the given packageId(s); restore installs a snapshot into the local Mods folder so RimWorld loads that old version instead of the workshop copy; remove_local deletes a RimList-installed local copy (restored snapshot or git clone) to go back; delete removes a snapshot.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'backup', 'restore', 'remove_local', 'delete'] },
          packageId: { type: 'string' },
          ids: { type: 'array', items: { type: 'string' }, description: 'backup: several packageIds' },
          id: { type: 'string', description: 'restore/delete: snapshot id from list' },
        },
        required: ['action'],
      },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        if (v.items) return [`${v.usage.count} snapshots, ${(v.usage.bytes / 1048576).toFixed(1)} MB`, ...v.items.map((b) => `${b.id}  ${b.name}  ${new Date(b.createdAt).toISOString().slice(0, 16)}  ${(b.size / 1048576).toFixed(1)} MB  (${b.reason})`)].join('\n')
        if (v.backups) return v.backups.map((b) => (b.skipped ? `already backed up: ${b.id}` : `backed up: ${b.id} (${(b.size / 1048576).toFixed(1)} MB)`)).join('\n') || 'nothing to back up'
        if (v.folder) return `Restored ${v.meta?.name} → ${v.path}\n${v.note}`
        if (v.removed) return 'Removed ' + v.removed
        return JSON.stringify(v.result ?? v)
      }),
      execute: (args) => {
        const m = { list: 'modBackups', backup: 'backupMod', restore: 'restoreModBackup', remove_local: 'removeLocalMod', delete: 'deleteModBackup' }[args.action]
        return m ? run(m, args) : { ok: false, error: 'unknown action' }
      },
    },
    {
      name: 'rimlist_git',
      description: 'Install or update RimWorld mods from git (GitHub etc.) into the local Mods folder. action=install clones url (https/ssh or "owner/repo"), optional branch, activate=true also enables it; action=check fetches and reports commits behind (all git mods or one packageId); action=update does git pull --ff-only (a snapshot is taken first).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['install', 'check', 'update'] },
          url: { type: 'string' },
          branch: { type: 'string' },
          activate: { type: 'boolean' },
          packageId: { type: 'string' },
        },
        required: ['action'],
      },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        if (v.mods) return v.mods.length ? v.mods.map((m) => (m.error ? `${m.name}: ${m.error}` : `${m.name} (${m.key}) @ ${m.git?.head}: ${m.behind ? m.behind + ' commits behind\n' + m.commits.map((c) => '   ' + c.hash + ' ' + c.text).join('\n') : 'up to date'}`)).join('\n') : 'No git mods installed.'
        if (v.from !== undefined) return v.changed ? `Updated ${v.name}: ${v.from} → ${v.to}` : `${v.name} already up to date (${v.to})`
        return v.warning ? `Cloned to ${v.path} — ${v.warning}` : `Installed ${v.name} (${v.packageId}) → ${v.path}${v.activated ? ', activated' : ' (not activated)'}`
      }),
      execute: (args) => run({ install: 'gitInstall', check: 'gitCheck', update: 'gitUpdate' }[args.action] || 'gitCheck', args),
    },
    {
      name: 'rimlist_game_log',
      description: "Read RimWorld's Player.log (the newest game run; previous=true for Player-prev.log) as a compact summary: unique errors/warnings with repeat counts, first stack frames, and which active mods each error mentions. Use it to diagnose red errors, crashes or broken mods after launching the game.",
      parameters: {
        type: 'object',
        properties: {
          previous: { type: 'boolean', description: 'Read Player-prev.log (the run before) instead of Player.log' },
          level: { type: 'string', enum: ['error', 'warning'], description: 'error = errors only; warning = errors + warnings (default)' },
        },
      },
      output: textOut((v) => (v.ok ? v.text : 'Error: ' + v.error)),
      execute: (args) => run('logSummary', args),
    },
    {
      name: 'rimlist_pin_order',
      description: 'Pin the current relative order of several active mods as user rules (a loadAfter chain), so Sort keeps them in this order from now on. Use after manually arranging mods that the community database orders wrongly.',
      parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'packageIds (at least two, currently active)' }, comment: { type: 'string' } }, required: ['ids'] },
      output: textOut((v) => (v.ok ? 'Pinned order: ' + v.chain.join(' → ') : 'Error: ' + v.error)),
      execute: (args) => run('pinOrder', args),
    },
    {
      name: 'rimlist_databases',
      description: 'Show or change the rule database sources (RimSort-compatible): community rules, Steam Workshop DB, No Version Warning, Use This Instead, RimWorld versions. Each can be none | github (default) | url (raw file, .gz or repo .zip) | local (file on disk, e.g. an existing RimSort install). action=status shows everything; action=configure changes one database and refreshes it; action=refresh re-downloads one or all.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'configure', 'refresh'] },
          key: { type: 'string', enum: ['community', 'steam', 'noVersionWarning', 'useThisInstead', 'versions'] },
          mode: { type: 'string', enum: ['none', 'github', 'url', 'local'] },
          url: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['action'],
      },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const st = v.status || v
        const lines = []
        for (const k of ['community', 'steam', 'noVersionWarning', 'useThisInstead', 'versions']) {
          const d = st[k]
          if (!d) continue
          const n = d.rules ?? d.ids ?? d.entries ?? 0
          lines.push(`${d.label}: ${d.mode}${d.mode === 'url' ? ' ' + d.url : d.mode === 'local' ? ' ' + d.path : ''} — ${n} entries${d.fetchedAt ? ', ' + new Date(d.fetchedAt).toISOString().slice(0, 10) : ''}${d.error ? ' — ERROR ' + d.error : ''}`)
        }
        if (st.user) lines.push(`User rules: ${st.user.rules} (${st.user.enabled ? 'on' : 'off'})`)
        if (v.rimsort?.base) lines.push('RimSort data found at ' + v.rimsort.base)
        return lines.join('\n')
      }),
      async execute(args) {
        if (args.action === 'configure') {
          if (!args.key) return { ok: false, error: 'key required' }
          const r = await run('configureDatabase', { key: args.key, mode: args.mode, url: args.url, path: args.path })
          if (!r.ok) return r
          return { ok: true, status: await service.dispatch('rulesStatus', {}) }
        }
        if (args.action === 'refresh') {
          const r = await run('refreshRules', args.key ? { key: args.key } : { force: true })
          return r.ok ? { ok: true, status: r } : r
        }
        const r = await run('rulesStatus', {})
        if (!r.ok) return r
        return { ok: true, status: r, rimsort: await service.dispatch('rimsortPaths', {}).catch(() => null) }
      },
    },
    {
      name: 'rimlist_classify',
      description: 'Classify a RimWorld mod by reading About.xml, Defs, Patches, languages and DLL/Harmony signals. Output always includes exactly one primary_type, secondary_types, feature_tags, Chinese display tags, booleans, confidence and original-text evidence. Types: content, library, patch, translation, performance, ui, qol, utility. Results are cached by mod version.',
      parameters: {
        type: 'object',
        properties: {
          packageId: { type: 'string', description: 'Mod packageId to inspect' },
          force: { type: 'boolean', description: 'Bypass the cached result and scan again' },
        },
        required: ['packageId'],
      },
      output: textOut((v) => v.ok ? JSON.stringify(v.result || v, null, 2) : 'Error: ' + v.error),
      execute: (args) => run('classify', args),
    },
    {
      name: 'rimlist_classify_all',
      description: 'Classify all installed mods, or only active mods. Returns the requested structured classification fields for every mod and caches by version. Use this to build mod category lists.',
      parameters: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'Bypass cached results' },
          activeOnly: { type: 'boolean', description: 'Only classify active mods' },
        },
      },
      output: textOut((v) => v.ok ? JSON.stringify(v.tags || v.result || v, null, 2) : 'Error: ' + v.error),
      execute: (args) => run('classifyAll', args),
    },
    {
      name: 'rimlist_classify_save_ai',
      description: 'Save an AI-reviewed classification override for a mod. The result must include mod_name, package_id, author, supported_versions, one primary_type, secondary_types, feature_tags, display_tags_zh, four boolean flags, confidence and evidence. The detail view uses this override until replaced.',
      parameters: {
        type: 'object',
        properties: {
          packageId: { type: 'string' },
          result: { type: 'object', additionalProperties: false, required: ['mod_name', 'package_id', 'author', 'supported_versions', 'primary_type', 'secondary_types', 'feature_tags', 'display_tags_zh', 'is_content_mod', 'is_library', 'is_patch', 'is_translation', 'confidence', 'evidence'], properties: { mod_name: { type: 'string' }, package_id: { type: 'string' }, author: { type: 'string' }, supported_versions: { type: 'array', items: { type: 'string' } }, primary_type: { type: 'string', enum: MOD_TAG_TYPES }, secondary_types: { type: 'array', items: { type: 'string', enum: MOD_TAG_TYPES } }, feature_tags: { type: 'array', items: { type: 'string', enum: MOD_FEATURE_TAGS } }, display_tags_zh: { type: 'array', items: { type: 'string' } }, is_content_mod: { type: 'boolean' }, is_library: { type: 'boolean' }, is_patch: { type: 'boolean' }, is_translation: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, evidence: { type: 'array', minItems: 1, items: { type: 'string' } } } },
        },
        required: ['packageId', 'result'],
      },
      output: textOut((v) => v.ok ? JSON.stringify(v.result || v, null, 2) : 'Error: ' + v.error),
      execute: (args) => run('classifySaveAi', args),
    },
    {
      name: 'rimlist_set_tags',
      description: 'Set the display tags of a mod by hand (what the Mods tab tag filter and the detail view show), e.g. ["工具","我的常用"]. The edit is kept until reset=true restores the automatic tags. Tags are free text (Chinese or English), up to 10.',
      parameters: { type: 'object', properties: { packageId: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, reset: { type: 'boolean', description: 'Drop manual/AI tags and go back to automatic' } }, required: ['packageId'] },
      output: textOut((v) => (v.ok ? `${v.mod_name || v.package_id}: ${(v.display_tags_zh || []).join(', ')} (${v.source})` : 'Error: ' + v.error)),
      execute: (args) => run('setTags', args),
    },
    {
      name: 'rimlist_tag_review',
      description: 'Review (检查) mod tags. Returns a page of mods with their current tags, type, confidence, source (auto | ai | user), a short description and folder signals (Defs, patches, DLLs, languages), so you can judge whether the tags are right. Fix wrong ones with rimlist_set_tags (simple display tags) or rimlist_classify_save_ai (full classification). filter: auto = not yet reviewed (default), low = confidence below maxConfidence, reviewed = AI/user edited, all. Page with offset/next. Do not overwrite source=user tags unless the user asks.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['auto', 'low', 'reviewed', 'all'] },
          activeOnly: { type: 'boolean', description: 'Only active mods (default true)' },
          maxConfidence: { type: 'number', description: 'filter=low threshold (default 0.7)' },
          tag: { type: 'string', description: 'Only mods that carry this tag' },
          packageIds: { type: 'array', items: { type: 'string' }, description: 'Review exactly these mods' },
          offset: { type: 'number' },
          limit: { type: 'number', description: '1-50, default 20' },
        },
      },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const lines = [`${v.total} mods match; showing ${v.offset + 1}-${v.offset + v.mods.length}${v.next != null ? ` (next offset=${v.next})` : ''}`]
        for (const m of v.mods) {
          const sg = m.signals
          const sig = sg ? [sg.defs?.length && 'defs ' + sg.defs.join(' '), sg.patchOps && 'patchOps ' + sg.patchOps, sg.dlls?.length && 'dll ' + sg.dlls.join(' '), sg.languages?.length && 'lang ' + sg.languages.join(' '), sg.textures && 'tex ' + sg.textures].filter(Boolean).join('; ') : ''
          lines.push(`\n• ${m.name} [${m.packageId}]${m.active ? '' : ' (inactive)'}\n  tags: ${m.tags.join(', ')} · ${m.primary_type}${m.secondary_types.length ? '+' + m.secondary_types.join('+') : ''} · conf ${m.confidence} · ${m.source}\n  ${sig}\n  desc: ${m.description || '-'}`)
        }
        return lines.join('\n')
      }),
      execute: (args) => run('tagReview', args),
    },
    {
      name: 'rimlist_reset_tags',
      description: 'Reset mod tags back to the automatic classification. Without packageIds every AI/user tag edit is removed; source=user or source=ai removes only that kind. Ask the user before resetting all.',
      parameters: { type: 'object', properties: { packageIds: { type: 'array', items: { type: 'string' } }, source: { type: 'string', enum: ['user', 'ai'] } } },
      output: textOut((v) => (v.ok ? `Reset ${v.removed} mod(s) to automatic tags` : 'Error: ' + v.error)),
      execute: (args) => run('resetAllTags', args),
    },
    {
      name: 'rimlist_get_note',
      description: 'Get the user note for a specific mod. Notes are free-form text that users write to remember details about a mod (compatibility issues, settings, reasons for using/not using it, etc.).',
      parameters: { type: 'object', properties: { packageId: { type: 'string', description: 'The mod packageId' } }, required: ['packageId'] },
      output: textOut((v) => (v.ok ? (v.note ? `Note for ${v.packageId}:\n${v.note}` : 'No note for this mod') : 'Error: ' + v.error)),
      execute: (args) => run('getNote', args),
    },
    {
      name: 'rimlist_set_note',
      description: 'Set or update the user note for a mod. Pass an empty string to remove the note. Notes help users remember important details and can be referenced by the AI when helping with mod-related questions.',
      parameters: { type: 'object', properties: { packageId: { type: 'string', description: 'The mod packageId' }, note: { type: 'string', description: 'The note text (empty string removes it)' } }, required: ['packageId', 'note'] },
      output: textOut((v) => (v.ok ? (v.note ? `Note saved for ${v.packageId}` : `Note removed for ${v.packageId}`) : 'Error: ' + v.error)),
      execute: (args) => run('setNote', args),
    },
    {
      name: 'rimlist_get_all_notes',
      description: 'Get all user notes for all mods. Use this to understand what the user has recorded about their mods (compatibility issues, preferences, reminders, etc.) when answering questions about their mod setup.',
      parameters: { type: 'object', properties: {} },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        const entries = Object.entries(v.notes)
        if (entries.length === 0) return 'No notes found'
        return entries.map(([pkg, { name, note }]) => `${name} [${pkg}]:\n  ${note}`).join('\n\n')
      }),
      execute: () => run('getAllNotes', {}),
    },
    {
      name: 'rimlist_debug_log',
      description: 'Read the RimList debug log file (last N lines). Use this to diagnose startup issues, launch failures, or other problems.',
      parameters: { type: 'object', properties: { lines: { type: 'number', description: 'Number of recent lines to return (default 100)' } } },
      output: textOut((v) => {
        if (!v.ok) return 'Error: ' + v.error
        if (v.lines.length === 0) return `No log entries found at ${v.path}`
        return `Debug log (${v.lines.length} of ${v.total} lines from ${v.path}):\n\n${v.lines.join('\n')}`
      }),
      execute: (args) => run('getDebugLog', args),
    },
    {
      name: 'rimlist_clear_debug_log',
      description: 'Clear the RimList debug log file.',
      parameters: { type: 'object', properties: {} },
      output: textOut((v) => (v.ok ? `Cleared debug log at ${v.path}` : 'Error: ' + v.error)),
      execute: () => run('clearDebugLog', {}),
    },
  ]
  for (const tool of tools) ctx.tools.register(tool)

  // ---- Session gate: rimlist_* tools are hidden until the user types /rimlist in that session ----
  const disposeGate = installToolGate(ctx, tools.map((t) => t.name), log)

  // ---- Bundled skill (user-only: activated by typing /rimlist; hidden from the model's catalog) ----
  // Soft inject: compositions without a skills service just skip it.
  let disposeSkill = null
  ctx.inject(['skills'], (sctx) => {
    if (!sctx.skills || typeof sctx.skills.register !== 'function') return log('skills service unavailable, skill not registered')
    const definition = loadSkillDefinition()
    if (!definition) return log('skill not registered: SKILL.md missing or incomplete at ' + SKILL_FILE)
    try {
      const d = sctx.skills.register(definition)
      disposeSkill = typeof d === 'function' ? d : null
      log('skill "' + definition.name + '" registered')
    } catch (err) {
      log('skill registration failed: ' + ((err && err.message) || err))
    }
  })

  return () => {
    disposeGate()
    if (disposeSkill) disposeSkill()
    routeState.disposed = true
    if (routeState.timer) routeState.timer()
    if (routeState.dispose) routeState.dispose()
  }
}
