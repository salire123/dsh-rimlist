import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useRimlist } from './store.js'
import { ActiveColumn, InactiveColumn } from './columns.jsx'
import { DetailPanel, DiagnosticsPanel, ListsPanel, RulesPanel, SettingsPanel } from './panels.jsx'
import { LogPanel } from './logpanel.jsx'
import { VersionsPanel } from './versions.jsx'
import { SavesPanel } from './saves.jsx'
import { t, subscribe, snapshot } from './i18n.js'
import { api, subscribeMod, unsubscribeMod } from './api.js'

const svg = (d, extra = '') => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d + extra }} />
const ICONS = {
  detail: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  diag: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.5"/>'),
  lists: svg('<path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11"/>'),
  rules: svg('<path d="M4 7h10M4 12h16M4 17h7"/><circle cx="17" cy="7" r="2"/><circle cx="14" cy="17" r="2"/>'),
  versions: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  saves: svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 14h8M8 17h8"/>'),
  log: svg('<path d="M5 4h14v16H5z"/><path d="M8 8h1M11 8h5M8 12h1M11 12h5M8 16h1M11 16h3"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
}

/* Height of the lower panel (diagnostics / lists / rules / versions) as a
 * percentage of the side column. The splitter above it sets this, and the value
 * is remembered per browser so the layout survives a reload. */
const SPLIT_KEY = 'dsh-rimlist.sideSplit'
const SPLIT_DEFAULT = 55
const SPLIT_MIN = 20
const SPLIT_MAX = 85
const clampSplit = (v) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))

/* The conversation.view host does not give its body a fixed height, so a
 * height:100% root grows with its content and the whole page scrolls. Pin the
 * root to the visible height of its scroll container so each column scrolls on
 * its own instead. The sidebar variant already has a bounded height. */
function useFitHeight(el, enabled) {
  useEffect(() => {
    if (!enabled || !el || typeof window === 'undefined') return
    const findScroller = () => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p
      }
      return null
    }
    let raf = 0
    const fit = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const sc = findScroller()
        let h
        if (sc) {
          const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
          h = sc.clientHeight - top
        } else {
          h = window.innerHeight - el.getBoundingClientRect().top - window.scrollY
        }
        if (h > 200) el.style.height = Math.floor(h) + 'px'
      })
    }
    fit()
    window.addEventListener('resize', fit)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    const sc = findScroller()
    if (ro) ro.observe(sc || document.documentElement)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
      ro?.disconnect()
      el.style.height = ''
    }
  }, [el, enabled])
}
const readSplit = () => {
  try {
    const v = Number(window.localStorage.getItem(SPLIT_KEY))
    if (Number.isFinite(v) && v > 0) return clampSplit(v)
  } catch {}
  return SPLIT_DEFAULT
}

export function RimlistApp({ inSidebar } = {}) {
  useSyncExternalStore(subscribe, snapshot, snapshot) // re-render on locale change
  const { snap, error, busy, toast, active, dirty, diag, catalog, actions } = useRimlist()
  const [selection, setSelection] = useState({ keys: new Set(), anchor: null, side: null })
  // lower panel under the always-visible detail view: diagnostics | lists | rules | versions | settings | null (collapsed)
  const [panel, setPanel] = useState(null)
  // Height (%) of the lower panel; draggable via the splitter above it.
  const [split, setSplit] = useState(readSplit)
  const persistSplit = (v) => {
    try {
      window.localStorage.setItem(SPLIT_KEY, String(v))
    } catch {}
  }
  const saveSplit = (v) => {
    const n = clampSplit(v)
    setSplit(n)
    persistSplit(n)
  }
  const [logOpen, setLogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeFilter, setActiveFilter] = useState('')
  const [inactiveFilter, setInactiveFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [mode, setMode] = useState('active') // compact layouts: inactive | active | panel
  const activeSet = useMemo(() => new Set(active), [active])
  // Tag filter (shared by both columns) + key -> display tags index, loaded once in the background.
  const [tagIndex, setTagIndex] = useState(null)
  const [activeTag, setActiveTag] = useState('')
  const [inactiveTag, setInactiveTag] = useState('')
  const loadTags = () => api('tagIndex', {}).then((r) => setTagIndex(r.tags || {})).catch(() => setTagIndex({}))
  useEffect(() => {
    if (snap && !tagIndex) loadTags()
  }, [snap])
  // Tag counts over a set of keys, most used first.
  const countTags = (keys) => {
    const n = new Map()
    for (const k of keys) for (const g of tagIndex?.[k]?.tags || []) n.set(g, (n.get(g) || 0) + 1)
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }
  const allTags = useMemo(() => countTags(Object.keys(tagIndex || {})), [tagIndex])
  // Each column only offers the tags its own mods have, with counts for that column.
  const activeTags = useMemo(() => countTags(active), [tagIndex, active])
  const inactiveTags = useMemo(() => countTags((snap?.mods || []).filter((m) => !activeSet.has(m.key)).map((m) => m.key)), [tagIndex, snap, activeSet])
  // Drop a selected tag that no longer exists in its column (e.g. after activating its last mod).
  useEffect(() => {
    if (activeTag && !activeTags.some(([g]) => g === activeTag)) setActiveTag('')
    if (inactiveTag && !inactiveTags.some(([g]) => g === inactiveTag)) setInactiveTag('')
  }, [activeTags, inactiveTags])
  const onTagsChanged = (key, tags) => setTagIndex((x) => ({ ...(x || {}), [key]: { ...(x?.[key] || {}), tags: tags?.display_tags_zh || [], source: tags?.source } }))

  const issuesByMod = useMemo(() => {
    const m = new Map()
    for (const i of diag?.issues || []) {
      if (!m.has(i.mod)) m.set(i.mod, [])
      m.get(i.mod).push(i)
    }
    return m
  }, [diag])
  const selectedKey = selection.anchor
  const selectedMod = selectedKey ? catalog.get(selectedKey) : null

  const [running, setRunning] = useState(false)
  useEffect(() => {
    let alive = true
    const poll = () => api('gameStatus').then((r) => alive && setRunning(!!r?.running)).catch(() => {})
    poll()
    const id = setInterval(poll, 4000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])
  const stopGameNow = async () => {
    if (!confirm(t('stopConfirm'))) return
    let r = await actions.api('stopGame', {})
    if (r && r.stopped === false && r.running !== false) {
      if (!confirm(t('stopForce'))) return
      r = await actions.api('stopGame', { force: true, waitMs: 0 })
    }
    if (r) actions.say(r.stopped ? t('stopped') : r.running === false ? t('notRunning') : t('stopFailed'))
    api('gameStatus').then((x) => setRunning(!!x?.running)).catch(() => {})
  }
  const startGame = async (quicktest = false) => {
    console.log('[RimList] startGame called, quicktest:', quicktest)
    const cfg = snap.settings?.launch || {}
    console.log('[RimList] launch config:', cfg)
    if (dirty) {
      if (cfg.saveFirst !== false) await actions.save()
      else if (!confirm(t('launchUnsaved'))) return
    }
    try {
      console.log('[RimList] calling api launch...')
      const r = await actions.api('launch', quicktest ? { quicktest: true } : {})
      console.log('[RimList] launch result:', r)
      actions.say((quicktest ? t('launchedQuick') : t('launched')) + (r.note ? ' — ' + r.note : ''))
      setTimeout(() => api('gameStatus').then((x) => setRunning(!!x?.running)).catch(() => {}), 2500)
    } catch (err) {
      console.error('[RimList] launch error:', err)
      actions.say('❌ ' + (err.message || String(err)))
    }
  }
  const ignoreIssue = async (i) => {
    await actions.api('addRule', { packageId: i.mod, kind: 'ignoreIncompatible', target: i.target, comment: 'ignored from diagnostics', name: catalog.get(i.target)?.name }, t('ignoredDone'))
    actions.refresh()
  }
  const jump = (key) => {
    setSelection({ keys: new Set([key]), anchor: key, side: activeSet.has(key) ? 'active' : 'inactive' })
    setLogOpen(false)
    setSettingsOpen(false)
    setMode('panel')
    requestAnimationFrame(() => document.querySelector(`.rl-root .rl-row[title="${CSS.escape(catalog.get(key)?.packageId || key)}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  const activateKeys = (keys, index) => {
    actions.activate(keys, index)
    setSelection({ keys: new Set(keys), anchor: keys[0], side: 'active' })
  }
  const deactivateKeys = (keys) => {
    actions.deactivate(keys)
    setSelection({ keys: new Set(keys), anchor: keys[0], side: 'inactive' })
  }
  const replaceKey = (oldKey, newKey) => {
    actions.replace(oldKey, newKey)
    setSelection({ keys: new Set([newKey]), anchor: newKey, side: 'active' })
    actions.say(`⇄ ${catalog.get(oldKey)?.name || oldKey} → ${catalog.get(newKey)?.name || newKey} — ${t('unsaved')}`)
  }

  const handleSubscribe = async (pfid) => {
    try {
      await subscribeMod(pfid)
      actions.say(t('subscribeRequested') || 'Opening Steam to subscribe...')
    } catch (e) {
      actions.say(t('subscribeFailed') || 'Failed to open Steam')
    }
  }

  const handleUnsubscribe = async (pfid) => {
    try {
      await unsubscribeMod(pfid)
      actions.say(t('unsubscribeRequested') || 'Opening Steam to unsubscribe...')
    } catch (e) {
      actions.say(t('unsubscribeFailed') || 'Failed to open Steam')
    }
  }

  // Keyboard: Delete = deactivate selection, Enter = activate selection, Ctrl+S = save
  useEffect(() => {
    const onKey = (e) => {
      if (!document.querySelector('.rl-root')) return
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (dirty) actions.save()
      }
      if (e.key === 'Escape' && (logOpen || settingsOpen)) {
        setLogOpen(false)
        setSettingsOpen(false)
        return
      }
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return
      if (e.key === 'Delete' && selection.side === 'active' && selection.keys.size) deactivateKeys([...selection.keys])
      if (e.key === 'Enter' && selection.side === 'inactive' && selection.keys.size) activateKeys([...selection.keys])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const [rootEl, setRootEl] = useState(null)
  useFitHeight(rootEl, !inSidebar)

  const rootCls = 'rl-root' + (inSidebar ? ' rl-sidebar' : '')
  if (error) return <div className={rootCls} ref={setRootEl}><div className="rl-side"><div className="rl-error">{error}</div><button className="rl-btn" onClick={actions.refresh}>↻</button></div></div>
  if (!snap) return <div className={rootCls} ref={setRootEl}><div className="rl-loading">{t('loading')}</div></div>

  const counts = diag?.counts || { error: 0, warning: 0, info: 0 }
  const dot = counts.error ? 'rl-dot-err' : counts.warning ? 'rl-dot-warn' : 'rl-dot-ok'
  const issueTotal = counts.error + counts.warning
  const pendingUpdates = snap.mods.filter((m) => m.update?.needsUpdate && activeSet.has(m.key)).length
  const panels = [
    ['diagnostics', t('diagnostics'), ICONS.diag, issueTotal ? { n: issueTotal, tone: counts.error ? 'err' : 'warn' } : null],
    ['lists', t('lists'), ICONS.lists, snap.lists?.length ? { n: snap.lists.length } : null],
    ['saves', t('savesTab'), ICONS.saves, null],
    ['rules', t('rules'), ICONS.rules, snap.rules?.user?.rules ? { n: snap.rules.user.rules } : null],
    ['versions', t('versionsTab'), ICONS.versions, pendingUpdates ? { n: pendingUpdates, tone: 'warn' } : null],
  ]

  const modes = [
    ['inactive', `${t('inactive')} ${snap ? snap.mods.length - active.length : ''}`],
    ['active', `${t('active')} ${active.length}`],
    ['panel', t('detail')],
  ]
  return (
    <div className={rootCls} ref={setRootEl}>
      <div className="rl-head">
        <div className="rl-brand"><b>RimList</b><span>RimWorld {snap.game?.major || '?'}</span></div>
        <span className="rl-stat"><span className={'rl-dot ' + dot} /> <b>{active.length}</b>/{snap.mods.length}</span>
        <span className="rl-stat" title={t('errors') + ' / ' + t('warnings')}><b style={{ color: counts.error ? 'var(--rl-err)' : undefined }}>{counts.error}</b> ✖ <b style={{ color: counts.warning ? 'var(--rl-warn)' : undefined }}>{counts.warning}</b> ▲</span>
        <div className="rl-head-spacer" />
        <button className="rl-btn rl-btn-lg" onClick={actions.sort} disabled={busy} title={t('sortTitle')}><span className="rl-btn-ico">⇅</span>{t('sort')}</button>
        <button className="rl-btn rl-btn-lg" onClick={actions.rescan} disabled={busy} title={t('rescan')}><span className="rl-btn-ico">↻</span>{t('refresh')}</button>
        {running ? (
          <button className="rl-btn rl-btn-lg rl-btn-stop" onClick={stopGameNow} disabled={busy} title={t('stopTitle')}><span className="rl-btn-ico">■</span>{t('stopGame')}</button>
        ) : (
          <>
            <button className="rl-btn rl-btn-lg rl-btn-play" onClick={() => startGame(false)} disabled={busy} title={t('launchTitle')}><span className="rl-btn-ico">▶</span>{t('launch')}</button>
            <button className="rl-btn rl-btn-lg" onClick={() => startGame(true)} disabled={busy} title={t('launchQuickTitle')}><span className="rl-btn-ico">⚡</span>{t('launchQuick')}</button>
          </>
        )}
        <button className={'rl-btn rl-btn-lg rl-btn-log' + (logOpen ? ' rl-gear-on' : '')} onClick={() => { setLogOpen(!logOpen); setSettingsOpen(false) }} title={t('gameLogTitle')}><span className="rl-btn-ico">{ICONS.log}</span>{t('gameLog')}</button>
        <button className={'rl-btn rl-btn-ghost rl-gear' + (settingsOpen ? ' rl-gear-on' : '')} onClick={() => { setSettingsOpen(!settingsOpen); setLogOpen(false) }} title={t('settings')}>{ICONS.gear}</button>
        {dirty && <button className="rl-btn rl-btn-ghost" onClick={actions.discard}>✕</button>}
        <button className={'rl-btn rl-btn-primary' + (dirty ? ' rl-pulse' : '')} onClick={actions.save} disabled={busy || !dirty} title={dirty ? t('unsaved') + ' — Ctrl+S' : t('saved')}>
          {t('save')}
        </button>
      </div>
      {!snap.game && <div className="rl-error" style={{ margin: 10 }}>{t('noGame')}</div>}
      <div className="rl-mode">
        <div className="rl-tabs">
          {modes.map(([v, l]) => (
            <button key={v} className="rl-tab" aria-selected={mode === v} onClick={() => setMode(v)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="rl-body" data-mode={mode}>
        <InactiveColumn
          mods={snap.mods}
          activeSet={activeSet}
          selection={selection}
          setSelection={setSelection}
          onActivate={activateKeys}
          onDeactivate={deactivateKeys}
          issuesByMod={issuesByMod}
          major={snap.game?.major}
          filter={inactiveFilter}
          setFilter={setInactiveFilter}
          sourceFilter={sourceFilter}
          setSourceFilter={setSourceFilter}
          tagIndex={tagIndex}
          allTags={inactiveTags}
          tag={inactiveTag}
          setTag={setInactiveTag}
          onSubscribe={handleSubscribe}
        />
        <ActiveColumn
          mods={snap.mods}
          catalog={catalog}
          order={active}
          issuesByMod={issuesByMod}
          selection={selection}
          setSelection={setSelection}
          onDeactivate={deactivateKeys}
          onMove={actions.move}
          onReorder={actions.setOrder}
          onDropFromInactive={activateKeys}
          major={snap.game?.major}
          filter={activeFilter}
          setFilter={setActiveFilter}
          tagIndex={tagIndex}
          allTags={activeTags}
          tag={activeTag}
          setTag={setActiveTag}
        />
        <div className="rl-col rl-col-side">
          <div className="rl-side-top">
            <div className="rl-panel-sub">{ICONS.detail}<span>{selectedMod ? selectedMod.name : t('detail')}</span></div>
            <DetailPanel mod={selectedMod} catalog={catalog} activeSet={activeSet} issues={selectedKey ? issuesByMod.get(selectedKey) : null} onJump={jump} onActivate={activateKeys} onDeactivate={deactivateKeys} position={selectedKey ? active.indexOf(selectedKey) : -1} actions={actions} allTags={allTags} onTagsChanged={onTagsChanged} onUnsubscribe={handleUnsubscribe} />
          </div>
          <div className={'rl-side-bottom' + (panel ? ' rl-open' : '')} style={panel ? { flex: '0 0 ' + split + '%' } : undefined}>
            {panel ? (
              <div
                className="rl-splitter"
                role="separator"
                aria-orientation="horizontal"
                aria-valuenow={Math.round(split)}
                aria-valuemin={SPLIT_MIN}
                aria-valuemax={SPLIT_MAX}
                title={t('dragResize')}
                tabIndex={0}
                onDoubleClick={() => saveSplit(SPLIT_DEFAULT)}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 10 : 3
                  if (e.key === 'ArrowUp') { e.preventDefault(); saveSplit(split + step) }
                  else if (e.key === 'ArrowDown') { e.preventDefault(); saveSplit(split - step) }
                  else if (e.key === 'Home') { e.preventDefault(); saveSplit(SPLIT_DEFAULT) }
                }}
                onPointerDown={(e) => {
                  const col = e.currentTarget.parentElement?.parentElement
                  if (!col) return
                  e.preventDefault()
                  const rect = col.getBoundingClientRect()
                  let live = split
                  const move = (ev) => {
                    if (!rect.height) return
                    // Distance from the pointer to the bottom of the column = panel height.
                    live = clampSplit(((rect.bottom - ev.clientY) / rect.height) * 100)
                    setSplit(live)
                  }
                  const up = () => {
                    window.removeEventListener('pointermove', move)
                    window.removeEventListener('pointerup', up)
                    window.removeEventListener('pointercancel', up)
                    document.body.classList.remove('rl-resizing')
                    persistSplit(live)
                  }
                  document.body.classList.add('rl-resizing')
                  window.addEventListener('pointermove', move)
                  window.addEventListener('pointerup', up)
                  window.addEventListener('pointercancel', up)
                }}
              >
                <span className="rl-splitter-grip" />
              </div>
            ) : null}
            <div className="rl-paneltabs" role="tablist">
              {panels.map(([v, l, icon, badge]) => (
                <button key={v} role="tab" className="rl-paneltab" aria-selected={panel === v} onClick={() => setPanel(panel === v ? null : v)} title={l}>
                  {icon}
                  <span className="rl-paneltab-label">{l}</span>
                  {badge && <span className={'rl-badge' + (badge.tone ? ' rl-badge-' + badge.tone : '')}>{badge.n}</span>}
                </button>
              ))}
              {panel && <button className="rl-paneltab rl-paneltab-close" onClick={() => setPanel(null)} title={t('collapse')}>▾</button>}
            </div>
            {panel && (
              <div className="rl-side-bottom-body">
                {panel === 'diagnostics' && <DiagnosticsPanel diag={diag} onJump={jump} onActivate={activateKeys} onSort={actions.sort} onIgnore={ignoreIssue} onReplace={replaceKey} />}
                {panel === 'lists' && <ListsPanel snap={snap} active={active} catalog={catalog} actions={actions} onJump={jump} />}
                {panel === 'saves' && <SavesPanel snap={snap} catalog={catalog} actions={actions} onJump={jump} />}
                {panel === 'rules' && <RulesPanel snap={snap} catalog={catalog} actions={actions} selectedKey={selectedKey} selection={selection} activeOrder={active} />}
                {panel === 'versions' && <VersionsPanel snap={snap} catalog={catalog} actions={actions} onJump={jump} active={active} />}
              </div>
            )}
          </div>
        </div>
        {settingsOpen && (
          <div className="rl-log-overlay rl-settings-overlay">
            <div className="rl-log-overlay-head">
              {ICONS.gear}
              <b>{t('settings')}</b>
              <div className="rl-head-spacer" />
              <button className="rl-btn rl-btn-sm" onClick={() => setSettingsOpen(false)} title="Esc">✕ {t('close')}</button>
            </div>
            <SettingsPanel snap={snap} actions={actions} />
          </div>
        )}
        {logOpen && (
          <div className="rl-log-overlay">
            <div className="rl-log-overlay-head">
              {ICONS.log}
              <b>{t('gameLog')}</b>
              <div className="rl-head-spacer" />
              <button className="rl-btn rl-btn-sm" onClick={() => setLogOpen(false)} title="Esc">✕ {t('close')}</button>
            </div>
            <LogPanel catalog={catalog} onJump={jump} say={actions.say} />
          </div>
        )}
      </div>
      {toast && <div className="rl-toast">{toast}</div>}
    </div>
  )
}
