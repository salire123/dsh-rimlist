import { useEffect, useState } from 'react'
import { api, workshopUrl } from './api.js'
import { t } from './i18n.js'

const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '—')
const ago = (ms) => {
  if (!ms) return ''
  const s = (Date.now() - ms) / 1000
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + t('minAgo')
  if (s < 86400) return Math.round(s / 3600) + t('hourAgo')
  return Math.round(s / 86400) + t('dayAgo')
}
const mb = (b) => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB'

/* ------------------------------------------------- per-mod: changelog + snapshots (in DetailPanel) */
export function ModVersionSection({ mod, actions }) {
  const [log, setLog] = useState(null)
  const [snaps, setSnaps] = useState(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = (force) => {
    setLog(null)
    api('modChangelog', { packageId: mod.key, force }).then(setLog).catch((e) => setLog({ kind: 'error', error: e.message, entries: [] }))
    api('modBackups', { packageId: mod.key }).then((r) => setSnaps(r.items)).catch(() => setSnaps([]))
  }
  useEffect(() => {
    setLog(null)
    setSnaps(null)
    if (open) load(false)
  }, [mod.key, open])
  if (mod.kind !== 'mod') return null
  const u = mod.update || {}
  const run = async (fn) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rl-ver">
      <button className="rl-ver-head" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'} {t('updateLog')} &amp; {t('modBackupsTitle')}</span>
        <span className="rl-muted">
          {u.git ? `git ${u.git.head}` : u.installedAt ? `${t('updatedAt')} ${ago(u.installedAt)}` : ''}
          {u.needsUpdate && <span className="rl-tag rl-tag-warn" style={{ marginLeft: 6 }}>{t('updatePending')}</span>}
          {u.restored && <span className="rl-tag rl-tag-info" style={{ marginLeft: 6 }}>{t('pinnedOld')}</span>}
        </span>
      </button>
      {open && (
        <div className="rl-ver-body">
          <div className="rl-card-actions">
            <button className="rl-btn rl-btn-sm" disabled={busy} onClick={() => run(async () => { await actions.api('backupMod', { packageId: mod.key }, t('backedUp')); load(false) })}>⤓ {t('backupNow')}</button>
            {u.git && <button className="rl-btn rl-btn-sm" disabled={busy} onClick={() => run(async () => { const r = await actions.api('gitUpdate', { packageId: mod.key }); actions.say(r.changed ? `✓ ${r.from} → ${r.to}` : t('upToDate')); await actions.refresh(); load(false) })}>⟳ git pull</button>}
            {(u.restored || u.git) && <button className="rl-btn rl-btn-sm rl-btn-danger" disabled={busy} onClick={() => run(async () => { if (!confirm(t('removeLocalConfirm'))) return; await actions.api('removeLocalMod', { packageId: mod.key }, '✓'); await actions.refresh() })}>✕ {t('removeLocal')}</button>}
            <span style={{ flex: 1 }} />
            <button className="rl-btn rl-btn-sm rl-btn-ghost" onClick={() => load(true)} title={t('refresh')}>↻</button>
          </div>

          {snaps && snaps.length > 0 && (
            <div className="rl-ver-snaps">
              {snaps.map((s) => (
                <div key={s.id} className="rl-ver-snap">
                  <span className="rl-mono">{fmt(s.createdAt)}</span>
                  <span className="rl-muted">{mb(s.size)} · {t('reason_' + s.reason) || s.reason}</span>
                  <span style={{ flex: 1 }} />
                  <button className="rl-btn rl-btn-sm" disabled={busy} title={t('rollbackTitle')} onClick={() => run(async () => { if (!confirm(t('rollbackConfirm'))) return; await actions.api('restoreModBackup', { id: s.id }, t('rolledBack')); await actions.refresh() })}>↶ {t('rollback')}</button>
                  <button className="rl-btn rl-btn-sm rl-btn-ghost" disabled={busy} onClick={() => run(async () => { await actions.api('deleteModBackup', { id: s.id }); load(false) })}>✕</button>
                </div>
              ))}
            </div>
          )}
          {snaps && snaps.length === 0 && <div className="rl-muted" style={{ fontSize: 12 }}>{t('noSnapshots')}</div>}

          {!log && <div className="rl-muted">{t('loading')}</div>}
          {log?.kind === 'none' && <div className="rl-muted" style={{ fontSize: 12 }}>{t('noUpdateLog')}</div>}
          {log?.kind === 'error' && <div className="rl-error">{log.error}</div>}
          {log?.entries?.length > 0 && (
            <div className="rl-ver-log">
              {log.entries.map((e, i) => (
                <div key={i} className={'rl-ver-entry' + (e.current ? ' rl-ver-current' : '') + (e.newer ? ' rl-ver-newer' : '') + (e.auto ? ' rl-ver-auto' : '')}>
                  <div className="rl-ver-time">
                    {fmt(e.time * 1000)}
                    {e.hash && <span className="rl-mono"> · {e.hash}</span>}
                    {e.current && <span className="rl-tag rl-tag-info">{t('installedVer')}</span>}
                    {e.newer && <span className="rl-tag rl-tag-warn">{t('newerVer')}</span>}
                  </div>
                  <div className="rl-ver-text">{e.auto ? t('autoUpdateNote') : e.text}</div>
                </div>
              ))}
              {log.url && <a href={log.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>{t('openChangelog')} ↗</a>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------- panel: recent updates / backups / git */
export function VersionsPanel({ snap, catalog, actions, onJump, active }) {
  const [tab, setTab] = useState('recent')
  return (
    <div className="rl-col" style={{ borderRight: 0 }}>
      <div className="rl-toolbar">
        <div className="rl-tabs" style={{ flex: 1 }}>
          {[['recent', t('recentUpdates')], ['backups', t('modBackupsTitle')], ['git', 'Git']].map(([v, l]) => (
            <button key={v} className="rl-tab" style={{ flex: 1 }} aria-selected={tab === v} onClick={() => setTab(v)}>{l}</button>
          ))}
        </div>
      </div>
      {tab === 'recent' && <RecentUpdates catalog={catalog} actions={actions} onJump={onJump} />}
      {tab === 'backups' && <BackupList snap={snap} actions={actions} onJump={onJump} active={active} />}
      {tab === 'git' && <GitPanel catalog={catalog} actions={actions} onJump={onJump} />}
    </div>
  )
}

function RecentUpdates({ actions, onJump }) {
  const [days, setDays] = useState(7)
  const [onlyActive, setOnlyActive] = useState(true)
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)
  const [cl, setCl] = useState({})
  useEffect(() => {
    setData(null)
    api('modUpdates', { days, onlyActive }).then(setData).catch((e) => setData({ error: e.message, recent: [], pending: [] }))
  }, [days, onlyActive])
  const toggle = async (k) => {
    setOpen(open === k ? null : k)
    if (!cl[k]) {
      const r = await api('modChangelog', { packageId: k }).catch((e) => ({ entries: [], error: e.message }))
      setCl((c) => ({ ...c, [k]: r }))
    }
  }
  return (
    <>
      <div className="rl-toolbar">
        {[1, 7, 30, 90].map((d) => (
          <button key={d} className="rl-chip" aria-pressed={days === d} onClick={() => setDays(d)}>{d}{t('daysShort')}</button>
        ))}
        <span style={{ flex: 1 }} />
        <label className="rl-muted" style={{ fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> {t('onlyActive')}</label>
      </div>
      <div className="rl-list" style={{ padding: 0 }}>
        {!data && <div className="rl-loading">{t('loading')}</div>}
        {data?.error && <div className="rl-error">{data.error}</div>}
        {data?.pending?.length > 0 && (
          <div className="rl-ver-pending">
            <b>{t('updatePending')} ({data.pending.length})</b> — {t('pendingHint')}
            {data.pending.map((p) => <div key={p.key} className="rl-link" onClick={() => onJump(p.key)}>{p.name}</div>)}
          </div>
        )}
        {data && data.recent.length === 0 && <div className="rl-empty">{t('noRecentUpdates')}</div>}
        {data?.recent.map((r, i) => (
          <div key={r.key + i} className="rl-upd">
            <div className="rl-upd-row" onClick={() => toggle(r.key)}>
              <span className="rl-upd-caret">{open === r.key ? '▾' : '▸'}</span>
              <span className="rl-upd-name" onClick={(e) => { e.stopPropagation(); onJump(r.key) }}>{r.name}</span>
              {r.source !== 'workshop' && <span className="rl-tag">{r.source}</span>}
              {r.hasBackup && <span className="rl-tag rl-tag-info" title={t('hasBackup')}>⤓</span>}
              <span className="rl-upd-time" title={fmt(r.time)}>{ago(r.time)}</span>
            </div>
            {open === r.key && (
              <div className="rl-upd-log">
                {!cl[r.key] && <span className="rl-muted">{t('loading')}</span>}
                {cl[r.key]?.entries?.slice(0, 5).map((e, j) => (
                  <div key={j} className={'rl-ver-entry' + (e.current ? ' rl-ver-current' : '')}>
                    <div className="rl-ver-time">{fmt(e.time * 1000)}{e.hash ? ' · ' + e.hash : ''}</div>
                    <div className="rl-ver-text">{e.auto ? t('autoUpdateNote') : e.text}</div>
                  </div>
                ))}
                <div className="rl-card-actions" style={{ marginTop: 6 }}>
                  <button className="rl-btn rl-btn-sm" onClick={() => onJump(r.key)}>{t('detail')} →</button>
                  {r.publishedFileId && <a className="rl-btn rl-btn-sm" href={`https://steamcommunity.com/sharedfiles/filedetails/changelog/${r.publishedFileId}`} target="_blank" rel="noreferrer">{t('openChangelog')} ↗</a>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function BackupList({ snap, actions, onJump, active }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const cfg = snap?.settings?.modBackup || { auto: false, keep: 3, onlyActive: true }
  const load = () => api('modBackups', {}).then(setData).catch((e) => setData({ error: e.message, items: [] }))
  useEffect(() => { load() }, [])
  const setCfg = async (patch) => {
    await actions.api('setModBackup', patch, '✓')
    await actions.refresh()
  }
  const backupAll = async () => {
    setBusy(true)
    try {
      const r = await actions.api('backupMod', { ids: active })
      const made = r.backups.filter((b) => !b.skipped).length
      actions.say(`✓ ${t('backedUp')} ${made}/${r.backups.length}`)
      load()
    } finally {
      setBusy(false)
    }
  }
  const groups = new Map()
  for (const b of data?.items || []) {
    if (!groups.has(b.key)) groups.set(b.key, [])
    groups.get(b.key).push(b)
  }
  return (
    <>
      <div className="rl-db" style={{ margin: 10 }}>
        <div className="rl-db-desc">{t('modBackupDesc')}</div>
        <div style={{ padding: '6px 12px 10px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 }}>
          <label style={{ cursor: 'pointer' }}><input type="checkbox" checked={!!cfg.auto} onChange={(e) => setCfg({ auto: e.target.checked })} /> {t('autoBackup')}</label>
          <label style={{ cursor: 'pointer' }}><input type="checkbox" checked={cfg.onlyActive !== false} onChange={(e) => setCfg({ onlyActive: e.target.checked })} /> {t('autoBackupActiveOnly')}</label>
          <label>{t('keepSnapshots')} <input className="rl-input" style={{ width: 60, display: 'inline-block', height: 24 }} type="number" min="1" max="50" defaultValue={cfg.keep} onBlur={(e) => Number(e.target.value) !== cfg.keep && setCfg({ keep: Number(e.target.value) })} /></label>
        </div>
        <div className="rl-db-foot">
          <span className="rl-muted" style={{ fontSize: 11.5 }}>{data?.usage ? `${data.usage.count} · ${mb(data.usage.bytes)}` : ''}</span>
          <span style={{ flex: 1 }} />
          <button className="rl-btn rl-btn-sm rl-btn-primary" disabled={busy} onClick={backupAll}>⤓ {t('backupActiveNow')}</button>
        </div>
      </div>
      <div className="rl-list" style={{ padding: 0 }}>
        {data && groups.size === 0 && <div className="rl-empty">{t('noSnapshots')}</div>}
        {[...groups.entries()].map(([k, items]) => (
          <div key={k} className="rl-upd">
            <div className="rl-upd-row"><span className="rl-upd-name" onClick={() => onJump(k)}>{items[0].name}</span><span className="rl-upd-time">{items.length} × · {mb(items.reduce((a, b) => a + b.size, 0))}</span></div>
            {items.map((s) => (
              <div key={s.id} className="rl-ver-snap" style={{ paddingLeft: 22 }}>
                <span className="rl-mono">{fmt(s.createdAt)}</span>
                <span className="rl-muted">{t('reason_' + s.reason) || s.reason}</span>
                <span style={{ flex: 1 }} />
                <button className="rl-btn rl-btn-sm" disabled={busy} onClick={async () => { if (!confirm(t('rollbackConfirm'))) return; await actions.api('restoreModBackup', { id: s.id }, t('rolledBack')); await actions.refresh() }}>↶ {t('rollback')}</button>
                <button className="rl-btn rl-btn-sm rl-btn-ghost" onClick={async () => { await actions.api('deleteModBackup', { id: s.id }); load() }}>✕</button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

function GitPanel({ catalog, actions, onJump }) {
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [activate, setActivate] = useState(true)
  const [busy, setBusy] = useState('')
  const [check, setCheck] = useState(null)
  const gitMods = [...catalog.values()].filter((m) => m.update?.git)
  const install = async () => {
    setBusy('install')
    try {
      const r = await actions.api('gitInstall', { url, branch: branch.trim() || undefined, activate })
      actions.say(r.warning ? '⚠ ' + r.warning : `✓ ${r.name}`)
      setUrl('')
      await actions.refresh()
    } finally {
      setBusy('')
    }
  }
  const doCheck = async () => {
    setBusy('check')
    try {
      setCheck(await actions.api('gitCheck', {}))
    } finally {
      setBusy('')
    }
  }
  const update = async (k) => {
    setBusy(k)
    try {
      const r = await actions.api('gitUpdate', { packageId: k })
      actions.say(r.changed ? `✓ ${r.name}: ${r.from} → ${r.to}` : t('upToDate'))
      await actions.refresh()
      setCheck(null)
    } finally {
      setBusy('')
    }
  }
  const behindOf = (k) => check?.mods?.find((m) => m.key === k)
  return (
    <>
      <div className="rl-db" style={{ margin: 10 }}>
        <div className="rl-db-head"><b>{t('gitInstall')}</b></div>
        <div className="rl-db-desc">{t('gitInstallDesc')}</div>
        <div style={{ padding: '6px 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input className="rl-input" placeholder="https://github.com/owner/repo  ·  owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && install()} />
          <div className="rl-form-row">
            <input className="rl-input" style={{ flex: 1 }} placeholder={t('gitBranch')} value={branch} onChange={(e) => setBranch(e.target.value)} />
            <label style={{ fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }}><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> {t('activateAfter')}</label>
          </div>
        </div>
        <div className="rl-db-foot">
          <span style={{ flex: 1 }} />
          <button className="rl-btn rl-btn-sm rl-btn-primary" disabled={!url.trim() || !!busy} onClick={install}>{busy === 'install' ? '…' : '⤓ ' + t('install')}</button>
        </div>
      </div>
      <div className="rl-toolbar">
        <b style={{ fontSize: 12.5 }}>{t('gitMods')} ({gitMods.length})</b>
        <span style={{ flex: 1 }} />
        <button className="rl-btn rl-btn-sm" disabled={!gitMods.length || !!busy} onClick={doCheck}>{busy === 'check' ? '…' : '⟳ ' + t('checkUpdates')}</button>
      </div>
      <div className="rl-list" style={{ padding: 0 }}>
        {gitMods.length === 0 && <div className="rl-empty">{t('noGitMods')}</div>}
        {gitMods.map((m) => {
          const c = behindOf(m.key)
          return (
            <div key={m.key} className="rl-upd">
              <div className="rl-upd-row">
                <span className="rl-upd-name" onClick={() => onJump(m.key)}>{m.name}</span>
                <span className="rl-mono rl-muted">{m.update.git.branch} @ {m.update.git.head}</span>
                {c && !c.error && (c.behind ? <span className="rl-tag rl-tag-warn">{c.behind} {t('commitsBehind')}</span> : <span className="rl-tag rl-tag-ok">✓</span>)}
                {c?.error && <span className="rl-tag rl-tag-err" title={c.error}>!</span>}
                <span style={{ flex: 1 }} />
                <button className="rl-btn rl-btn-sm" disabled={!!busy} onClick={() => update(m.key)}>{busy === m.key ? '…' : 'git pull'}</button>
              </div>
              <div className="rl-muted rl-mono" style={{ fontSize: 11, padding: '0 10px 4px 10px', wordBreak: 'break-all' }}>{m.update.git.remote}</div>
              {c?.commits?.length > 0 && <div className="rl-upd-log">{c.commits.slice(0, 8).map((x) => <div key={x.hash} className="rl-ver-text"><span className="rl-mono">{x.hash}</span> {x.text}</div>)}</div>}
            </div>
          )
        })}
      </div>
    </>
  )
}
