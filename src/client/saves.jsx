import { useEffect, useMemo, useState } from 'react'
import { api, steamClick, workshopUrl } from './api.js'
import { t } from './i18n.js'
import { DiffView } from './panels.jsx'

const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB')
const fmtDate = (ms) => new Date(ms).toLocaleString()

/** Lower-panel tab: RimWorld save files and the mod list stored in each one. */
export function SavesPanel({ snap, catalog, actions, onJump }) {
  const [data, setData] = useState(null) // { dir, exists, saves }
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('*')
  const [open, setOpen] = useState(null) // save name
  const load = async () => {
    setLoading(true)
    try {
      setData(await api('saves'))
    } catch (e) {
      actions.say('✖ ' + e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [snap?.paths?.savesDir])

  const folders = useMemo(() => {
    const n = new Map()
    for (const s of data?.saves || []) n.set(s.folder, (n.get(s.folder) || 0) + 1)
    return [...n.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])))
  }, [data])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data?.saves || []).filter((s) => (folder === '*' || s.folder === folder) && (!q || s.base.toLowerCase().includes(q)))
  }, [data, query, folder])

  return (
    <div className="rl-col" style={{ borderRight: 0 }}>
      <div className="rl-toolbar">
        <input className="rl-input" style={{ flex: 1, minWidth: 0 }} placeholder={t('savesSearch')} value={query} onChange={(e) => setQuery(e.target.value)} />
        {folders.length > 1 && (
          <select className="rl-select" value={folder} onChange={(e) => setFolder(e.target.value)} title={t('savesFolder')}>
            <option value="*">{t('all')} ({data.saves.length})</option>
            {folders.map(([f, n]) => <option key={f} value={f}>{f || t('savesRoot')} ({n})</option>)}
          </select>
        )}
        <button className="rl-btn rl-btn-sm" onClick={load} disabled={loading} title={t('refresh')}>↻</button>
      </div>
      <div className="rl-side">
        {!data ? (
          <div className="rl-empty">{t('loading')}</div>
        ) : !data.exists ? (
          <div className="rl-error">{t('savesNoDir')}{data.dir ? ': ' + data.dir : ''}</div>
        ) : (
          <>
            <div className="rl-muted" style={{ wordBreak: 'break-all' }}>{data.dir} · {shown.length}/{data.saves.length}</div>
            {!shown.length && <div className="rl-empty">{t('savesNone')}</div>}
            {shown.map((s) => (
              <SaveCard key={s.name} s={s} open={open === s.name} onToggle={() => setOpen(open === s.name ? null : s.name)} catalog={catalog} actions={actions} onJump={onJump} activeSig={(snap?.active || []).join(',')} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function SaveCard({ s, open, onToggle, catalog, actions, onJump, activeSig }) {
  const [detail, setDetail] = useState(null)
  const [err, setErr] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const [listName, setListName] = useState('')
  const [imported, setImported] = useState(null)
  const [installRes, setInstallRes] = useState(null)
  useEffect(() => {
    if (!open || detail) return
    setErr(null)
    api('saveDetail', { name: s.name }).then(setDetail, (e) => setErr(e.message))
  }, [open, detail])
  // Reload when the save file changes on disk or the saved load order changes (the diff is against it).
  useEffect(() => {
    setDetail(null)
  }, [s.mtime, activeSig])

  const doImport = async (apply) => {
    if (apply === 'replace' && !confirm(t('savesReplaceConfirm'))) return
    const r = await actions.api('importSave', { name: s.name, listName: listName.trim() || t('savesListPrefix') + ' ' + s.base.replace(/##/g, ' / ') }, apply ? null : t('savesImported'))
    if (!r) return
    setImported(r)
    if (apply) {
      const a = await actions.api('applyList', { id: r.list.id, mode: apply }, (apply === 'replace' ? t('applyReplace') : t('applyMerge')) + ' ✓')
      await actions.setOrderFromServer(a.active)
    } else actions.refresh()
  }
  const installMissing = async () => {
    const r = await actions.api('installMissing', { id: imported.list.id })
    if (!r) return
    setInstallRes(r)
    if (r.cloned.length) actions.refresh()
  }
  const decorate = (keys, d) => keys.map((k) => ({ packageId: k, name: catalog.get(k)?.name || d.mods.find((m) => m.packageId.toLowerCase() === k)?.name || k, installed: catalog.has(k) }))

  return (
    <div className="rl-card">
      <div className="rl-card-title" style={{ cursor: 'pointer', flexWrap: 'wrap' }} onClick={onToggle}>
        <span className="rl-muted">{open ? '▾' : '▸'}</span>
        <b style={{ wordBreak: 'break-all' }}>{s.title}</b>
        {s.folder && <span className="rl-chip">{s.folder}</span>}
        <small>{fmtDate(s.mtime)} · RW {s.gameVersion || '?'} · {s.error ? '✖' : `${s.modCount} ${t('mods')}`} · {fmtSize(s.size)}</small>
      </div>
      {s.error && <div className="rl-error">{s.error}</div>}
      {open && !s.error && (
        err ? <div className="rl-error">{err}</div> : !detail ? <div className="rl-muted">{t('loading')}</div> : (
          <>
            <div className="rl-muted">
              {detail.sameAsCurrent ? '✓ ' + t('savesSame') : t('savesDiffers')}
              {detail.missing.length ? ` · ${t('missing')} ${detail.missing.length}` : ''}
            </div>
            {!detail.sameAsCurrent && <DiffView d={{ added: decorate(detail.diff.added, detail), removed: decorate(detail.diff.removed, detail), reordered: decorate(detail.diff.reordered, detail), same: detail.diff.same }} onJump={onJump} />}
            {detail.missing.length > 0 && (
              <div className="rl-error">
                {t('missing')} ({detail.missing.length}):{' '}
                {detail.missing.map((m, i) => (
                  <span key={m.packageId}>
                    {i > 0 && ', '}
                    {m.publishedFileId ? <a className="rl-link" href={workshopUrl(m.publishedFileId)} onClick={steamClick(m.publishedFileId)} title={m.packageId}>{m.name || m.packageId}</a> : <span title={m.packageId}>{m.name || m.packageId}</span>}
                  </span>
                ))}
              </div>
            )}
            <div>
              <span className="rl-link" onClick={() => setShowAll(!showAll)}>{showAll ? '▾' : '▸'} {t('savesAllMods')} ({detail.mods.length})</span>
              {showAll && (
                <ol className="rl-code" style={{ whiteSpace: 'normal', margin: '6px 0 0', paddingLeft: 34 }}>
                  {detail.mods.map((m) => (
                    <li key={m.packageId} className={m.installed ? '' : 'rl-missing'} title={m.packageId} style={{ cursor: m.installed ? 'pointer' : 'default', color: m.installed ? undefined : 'var(--rl-err)' }} onClick={() => m.installed && onJump(m.packageId.toLowerCase())}>
                      {m.name || m.packageId} <span className="rl-muted">{m.packageId}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <input className="rl-input" placeholder={t('savesListPrefix') + ' ' + s.base.replace(/##/g, ' / ')} value={listName} onChange={(e) => setListName(e.target.value)} />
            <div className="rl-card-actions">
              <button className="rl-btn rl-btn-sm rl-btn-primary" onClick={() => doImport(null)} title={t('savesImportTitle')}>{t('savesImport')}</button>
              <button className="rl-btn rl-btn-sm" onClick={() => doImport('replace')} disabled={detail.sameAsCurrent}>{t('savesImportReplace')}</button>
              <button className="rl-btn rl-btn-sm" onClick={() => doImport('merge')} disabled={detail.sameAsCurrent}>{t('savesImportMerge')}</button>
            </div>
            {imported?.list && (
              <div className="rl-muted">
                ✓ {t('savesSavedAs')} “{imported.list.name}”
                {imported.missing.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <button className="rl-btn rl-btn-sm" onClick={installMissing} title={t('installMissingTitle')}>{t('installMissing')} ({imported.missing.length}) ↗</button>
                  </div>
                )}
                {installRes && (
                  <div style={{ marginTop: 6 }}>
                    {installRes.cloned.length > 0 && <div>✔ {t('gitCloned')}: {installRes.cloned.map((m) => m.name).join(', ')}</div>}
                    {installRes.opened.length > 0 && <div>↗ {t('steamOpened')}: {installRes.opened.map((m) => m.name).join(', ')}</div>}
                    {installRes.failed.length > 0 && <div>✖ {installRes.failed.map((m) => m.name + ' — ' + m.error).join('; ')}</div>}
                    {installRes.manual.length > 0 && <div>? {t('noSource')}: {installRes.manual.map((m) => m.name).join(', ')}</div>}
                    <div>{t('installThenApply')}</div>
                  </div>
                )}
              </div>
            )}
          </>
        )
      )}
    </div>
  )
}
