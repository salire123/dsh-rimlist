import { useEffect, useMemo, useState } from 'react'
import { api, previewUrl, workshopUrl, openSteam, steamClick } from './api.js'
import { t } from './i18n.js'
import { ModVersionSection } from './versions.jsx'
import { sendToChat } from './chat.js'

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : t('never'))

/** Key of the installed copy of a "Use This Instead" replacement (workshop id first, then a different packageId), or null. */
const installedReplacementKey = (rep, catalog, oldKey) => {
  if (!rep || !catalog) return null
  if (rep.newPfid) for (const [k, m] of catalog) if (k !== oldKey && m?.publishedFileId && String(m.publishedFileId) === String(rep.newPfid)) return k
  const np = rep.newPackageId ? String(rep.newPackageId).toLowerCase() : ''
  return np && np !== oldKey && catalog.has(np) ? np : null
}

/* ------------------------------------------------------------------ detail */
export function DetailPanel({ mod, catalog, activeSet, issues, onJump, onActivate, onDeactivate, position, actions, allTags = [], onTagsChanged, onUnsubscribe }) {
  const [full, setFull] = useState(null)
  const [explain, setExplain] = useState(null)
  const [zoom, setZoom] = useState(false)
  const [tags, setTags] = useState(mod?.tags || null)
  const [classifying, setClassifying] = useState(false)
  const [editing, setEditing] = useState(null) // array of tags being edited, or null
  const [newTag, setNewTag] = useState('')
  const [note, setNote] = useState('')
  const [editingNote, setEditingNote] = useState(false)
  const [noteText, setNoteText] = useState('')
  useEffect(() => {
    setEditing(null)
    setNewTag('')
    setZoom(false)
    setTags(mod?.tags || null)
    setFull(null)
    setExplain(null)
    setNote('')
    setEditingNote(false)
    setNoteText('')
    if (!mod) return
    let alive = true
    api('mod', { packageId: mod.key }).then((r) => alive && (setFull(r), setTags(r.tags || null), setNote(r.note || ''), setNoteText(r.note || ''))).catch(() => {})
    if (activeSet.has(mod.key)) api('explain', { packageId: mod.key }).then((r) => alive && setExplain(r)).catch(() => {})
    return () => {
      alive = false
    }
  }, [mod?.key, activeSet])
  const classify = async () => {
    if (!mod || classifying) return
    setClassifying(true)
    try {
      const r = await api('classify', { packageId: mod.key, force: true })
      setTags(r)
      onTagsChanged?.(mod.key, r)
    } finally {
      setClassifying(false)
    }
  }
  const saveTags = async (reset = false) => {
    const list = editing || []
    const extra = newTag.trim() ? [newTag.trim()] : []
    const r = await api('setTags', reset ? { packageId: mod.key, reset: true } : { packageId: mod.key, tags: [...list, ...extra] })
    setTags(r)
    onTagsChanged?.(mod.key, r)
    setEditing(null)
    setNewTag('')
  }
  const saveNote = async () => {
    try {
      await api('setNote', { packageId: mod.key, note: noteText })
      setNote(noteText)
      setEditingNote(false)
      actions?.say(t('noteSaved'))
    } catch (err) {
      actions?.say('❌ ' + (err.message || 'Error'))
    }
  }
  const addTag = (g) => {
    const v = String(g || '').trim()
    if (v && !(editing || []).includes(v)) setEditing([...(editing || []), v])
    setNewTag('')
  }
  if (!mod) return <div className="rl-empty">{t('search')}</div>
  const nameOf = (k) => catalog.get(k)?.name || k
  const Pill = ({ k, src }) => {
    const installed = catalog.has(k)
    const act = activeSet.has(k)
    return (
      <span className={'rl-pill' + (!installed ? ' rl-pill-missing' : !act ? ' rl-pill-inactive' : '')} onClick={() => installed && onJump(k)} title={k + (!installed ? ' — ' + t('missing') : !act ? ' — ' + t('inactive') : '')}>
        {nameOf(k)}
        {src && <span className="rl-pill-src">{src}</span>}
      </span>
    )
  }
  const steam = full?.steam
  return (
    <div className="rl-side">
      <div className="rl-detail-head">
        {mod.hasPreview ? <img className="rl-preview" src={previewUrl(mod.key)} alt="" onClick={() => setZoom(true)} /> : <div className="rl-preview rl-preview-empty">no preview</div>}
        {zoom && mod.hasPreview && <div className="rl-lightbox" onClick={() => setZoom(false)}><img src={previewUrl(mod.key)} alt="" /></div>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="rl-detail-title">{mod.name}</div>
          <div className="rl-detail-meta">
            {mod.packageId}
            {mod.author ? <> · {t('by')} {mod.author}</> : null}
            {mod.modVersion ? <> · v{mod.modVersion}</> : null}
            <br />
            {t('versions')}: {mod.supportedVersions.join(', ') || '—'}
            {mod.nvw && <span className="rl-tag rl-tag-info" style={{ marginLeft: 6 }} title={t('nvw')}>nvw</span>}
            {position >= 0 && <> · {t('position')} #{position + 1}</>}
            <br />
            {mod.publishedFileId && <a href={workshopUrl(mod.publishedFileId)} onClick={steamClick(mod.publishedFileId)}>{t('openWorkshop')} ↗</a>}
            {mod.url && !mod.publishedFileId && <a href={mod.url} target="_blank" rel="noreferrer">{mod.url} ↗</a>}
          </div>
          <div className="rl-card-actions" style={{ marginTop: 8 }}>
            {activeSet.has(mod.key) ? (
              <button className="rl-btn rl-btn-sm" onClick={() => onDeactivate([mod.key])}>← {t('deactivate')}</button>
            ) : (
              <button className="rl-btn rl-btn-sm rl-btn-primary" onClick={() => onActivate([mod.key])}>{t('activate')} →</button>
            )}
            {mod.source === 'workshop' && mod.publishedFileId && onUnsubscribe && (
              <button className="rl-btn rl-btn-sm" onClick={() => onUnsubscribe(mod.publishedFileId)} title={t('unsubscribe') || 'Unsubscribe from workshop'}>
                {t('unsubscribe') || '取消订阅'}
              </button>
            )}
          </div>
        </div>
      </div>

      {actions && <ModVersionSection mod={mod} actions={actions} />}

      <div className="rl-classify">
        <div className="rl-section-title">
          <span>Mod 类型</span>
          <span className="rl-card-actions">
            {tags && !editing && <button className="rl-btn rl-btn-sm" onClick={() => setEditing([...(tags.display_tags_zh || [])])}>✎ {t('editTags')}</button>}
            {!editing && <button className="rl-btn rl-btn-sm" onClick={classify} disabled={classifying}>{classifying ? '检查中…' : tags ? '重新检查' : '检查类型'}</button>}
          </span>
        </div>
        {editing ? (
          <div className="rl-tag-edit">
            <div className="rl-tags">
              {editing.map((g) => (
                <span key={g} className="rl-tag rl-tag-removable">{g}<button title={t('remove')} onClick={() => setEditing(editing.filter((x) => x !== g))}>×</button></span>
              ))}
              {!editing.length && <span className="rl-muted">{t('tagsEmpty')}</span>}
            </div>
            <div className="rl-toolbar" style={{ padding: 0, border: 0 }}>
              <input className="rl-input" list="rl-all-tags" placeholder={t('addTag')} value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addTag(newTag) } }} />
              <datalist id="rl-all-tags">{allTags.filter(([g]) => !editing.includes(g)).map(([g]) => <option key={g} value={g} />)}</datalist>
              <button className="rl-btn rl-btn-sm" onClick={() => addTag(newTag)} disabled={!newTag.trim()}>+</button>
            </div>
            <div className="rl-card-actions">
              <button className="rl-btn rl-btn-sm rl-btn-primary" onClick={() => saveTags(false)} disabled={!editing.length && !newTag.trim()}>{t('save')}</button>
              <button className="rl-btn rl-btn-sm" onClick={() => { setEditing(null); setNewTag('') }}>{t('cancel')}</button>
              {(tags?.source === 'user' || tags?.source === 'ai') && <button className="rl-btn rl-btn-sm" onClick={() => saveTags(true)} title={t('resetTagsTitle')}>↺ {t('resetTags')}</button>}
            </div>
          </div>
        ) : tags ? (
          <>
            <div className="rl-tags">
              <span className="rl-tag rl-tag-type">{tags.display_tags_zh?.[0] || tags.primary_type}</span>
              {tags.display_tags_zh?.slice(1).map((x) => <span key={x} className="rl-tag">{x}</span>)}
              <span className={'rl-tag ' + (tags.confidence >= 0.75 ? 'rl-tag-info' : 'rl-tag-warn')}>可信度 {Math.round((tags.confidence || 0) * 100)}%</span>
              {tags.source === 'ai' && <span className="rl-tag rl-tag-info">AI 已校正</span>}
              {tags.source === 'user' && <span className="rl-tag rl-tag-info">{t('userTags')}</span>}
            </div>
            <details className="rl-evidence">
              <summary>依据（{tags.evidence?.length || 0}）</summary>
              <ul>{(tags.evidence || []).map((e, i) => <li key={i}>“{e}”</li>)}</ul>
              <code>{tags.primary_type}{tags.secondary_types?.length ? ' + ' + tags.secondary_types.join(', ') : ''}</code>
            </details>
          </>
        ) : <div className="rl-muted">点击“检查类型”读取 About.xml、Defs、Patches 和 DLL 后自动分类。</div>}
      </div>

      <div className="rl-classify">
        <div className="rl-section-title">
          <span>{t('note')}</span>
          <span className="rl-card-actions">
            {!editingNote && <button className="rl-btn rl-btn-sm" onClick={() => setEditingNote(true)}>✎ {t('editNote')}</button>}
          </span>
        </div>
        {editingNote ? (
          <div style={{ marginTop: 8 }}>
            <textarea 
              className="rl-input" 
              placeholder={t('noteHint')} 
              value={noteText} 
              onChange={(e) => setNoteText(e.target.value)}
              rows={5}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div className="rl-card-actions" style={{ marginTop: 8 }}>
              <button className="rl-btn rl-btn-sm rl-btn-primary" onClick={saveNote}>{t('saveNote')}</button>
              <button className="rl-btn rl-btn-sm" onClick={() => { setEditingNote(false); setNoteText(note) }}>{t('cancel')}</button>
            </div>
          </div>
        ) : note ? (
          <div style={{ marginTop: 8, padding: 8, backgroundColor: 'var(--rl-bg-light)', borderRadius: 4, whiteSpace: 'pre-wrap', fontSize: 13 }}>
            {note}
          </div>
        ) : (
          <div className="rl-muted" style={{ marginTop: 8 }}>{t('noteHint')}</div>
        )}
      </div>

      {mod.replacement && (() => {
        const rep = mod.replacement
        const newKey = installedReplacementKey(rep, catalog, mod.key)
        return (
          <div className="rl-replace">
            <span className="rl-tag rl-tag-info">{t('replacement')}</span>
            <span>{t('useInstead')} <b>{rep.newName}</b>{rep.newAuthor ? ' · ' + rep.newAuthor : ''}{newKey && <span className="rl-muted"> · {t('replacementInstalled')}</span>}</span>
            {newKey && activeSet.has(mod.key) && !activeSet.has(newKey) && actions?.replace && (
              <button className="rl-btn rl-btn-sm rl-btn-primary" title={t('replaceHint')} onClick={() => { actions.replace(mod.key, newKey); onJump(newKey) }}>⇄ {t('replaceWith')}</button>
            )}
            {newKey && <button className="rl-btn rl-btn-sm rl-btn-ghost" onClick={() => onJump(newKey)}>→ {catalog.get(newKey)?.name || newKey}</button>}
            <a className="rl-btn rl-btn-sm" href={workshopUrl(rep.newPfid)} onClick={steamClick(rep.newPfid)}>Steam ↗</a>
          </div>
        )
      })()}
      {issues?.length > 0 && (
        <div>
          <div className="rl-section-title">{t('diagnostics')}</div>
          {issues.map((i, n) => <IssueRow key={n} issue={i} onJump={onJump} onActivate={onActivate} onReplace={actions?.replace ? (o, k) => { actions.replace(o, k); onJump(k) } : undefined} compact />)}
        </div>
      )}

      <dl className="rl-kv">
        {mod.dependsOn.length > 0 && (<><dt>{t('dependsOn')}</dt><dd className="rl-pill-list">{mod.dependsOn.map((d) => <Pill key={d.packageId} k={d.packageId} />)}</dd></>)}
        {(mod.loadAfter.length > 0 || mod.forceLoadAfter.length > 0 || Object.keys(mod.rules.loadAfter).length > 0) && (
          <><dt>{t('loadAfter')}</dt><dd className="rl-pill-list">
            {mod.forceLoadAfter.map((k) => <Pill key={'f' + k} k={k} src="force" />)}
            {mod.loadAfter.map((k) => <Pill key={k} k={k} src="about" />)}
            {Object.entries(mod.rules.loadAfter).map(([k, i]) => <Pill key={'r' + k} k={k} src={i.source} />)}
          </dd></>
        )}
        {(mod.loadBefore.length > 0 || mod.forceLoadBefore.length > 0 || Object.keys(mod.rules.loadBefore).length > 0) && (
          <><dt>{t('loadBefore')}</dt><dd className="rl-pill-list">
            {mod.forceLoadBefore.map((k) => <Pill key={'f' + k} k={k} src="force" />)}
            {mod.loadBefore.map((k) => <Pill key={k} k={k} src="about" />)}
            {Object.entries(mod.rules.loadBefore).map(([k, i]) => <Pill key={'r' + k} k={k} src={i.source} />)}
          </dd></>
        )}
        {(mod.incompatibleWith.length > 0 || Object.keys(mod.rules.incompatibleWith).length > 0) && (
          <><dt>{t('incompatible')}</dt><dd className="rl-pill-list">
            {mod.incompatibleWith.map((k) => <Pill key={k} k={k} src="about" />)}
            {Object.entries(mod.rules.incompatibleWith).map(([k, i]) => <Pill key={'r' + k} k={k} src={i.source} />)}
          </dd></>
        )}
        {(mod.rules.loadTop || mod.rules.loadBottom) && (<><dt>rule</dt><dd>{mod.rules.loadTop ? 'loadTop' : 'loadBottom'} <span className="rl-muted">({(mod.rules.loadTop || mod.rules.loadBottom).source}{(mod.rules.loadTop || mod.rules.loadBottom).comment ? ': ' + (mod.rules.loadTop || mod.rules.loadBottom).comment : ''})</span></dd></>)}
        {steam && !steam.isApp && Object.keys(steam.dependencies || {}).length > 0 && (
          <><dt>steam deps</dt><dd className="rl-pill-list">{Object.entries(steam.dependencies).map(([pfid, name]) => <a key={pfid} className="rl-pill" href={workshopUrl(pfid)} onClick={steamClick(pfid)}>{name}</a>)}</dd></>
        )}
        <dt>{t('openFolder')}</dt><dd className="rl-muted" style={{ wordBreak: 'break-all', fontFamily: 'var(--rl-mono)', fontSize: 11 }}>{mod.path}</dd>
      </dl>

      {explain && (explain.mustLoadAfter.length > 0 || explain.mustLoadBefore.length > 0) && (
        <div>
          <div className="rl-section-title">{t('explain')}</div>
          <dl className="rl-kv" style={{ marginTop: 8 }}>
            {explain.mustLoadAfter.length > 0 && (<><dt>{t('mustAfter')}</dt><dd className="rl-pill-list">{explain.mustLoadAfter.map((e) => <Pill key={e.target} k={e.target} src={e.source} />)}</dd></>)}
            {explain.mustLoadBefore.length > 0 && (<><dt>{t('mustBefore')}</dt><dd className="rl-pill-list">{explain.mustLoadBefore.map((e) => <Pill key={e.target} k={e.target} src={e.source} />)}</dd></>)}
          </dl>
        </div>
      )}

      {full?.description && <div className="rl-desc">{stripBB(full.description)}</div>}
    </div>
  )
}
const stripBB = (s) => String(s).replace(/\[\/?(b|i|u|h\d|url|img|list|\*|table|tr|td|size|color|quote|code|spoiler)[^\]]*\]/gi, '').replace(/\\n/g, '\n').trim()

/* -------------------------------------------------------------- diagnostics */
export function IssueRow({ issue, onJump, onActivate, onIgnore, onReplace, compact }) {
  const i = issue
  const cls = i.level === 'error' ? 'rl-issue-err' : i.level === 'warning' ? 'rl-issue-warn' : 'rl-issue-info'
  const icon = i.level === 'error' ? '✖' : i.level === 'warning' ? '▲' : 'i'
  return (
    <div className={'rl-issue ' + cls} onClick={() => onJump(i.mod)}>
      <div className="rl-issue-icon">{icon}</div>
      <div>
        {!compact && <div className="rl-issue-mod">{i.modName}</div>}
        <div className="rl-issue-msg">{i.message}</div>
        {(i.fix === 'activate' || i.fix === 'subscribe' || i.fix === 'replace' || i.target) && (
          <div className="rl-issue-fix" onClick={(e) => e.stopPropagation()}>
            {i.fix === 'ignore' && onIgnore && <button className="rl-btn rl-btn-sm" title={t('ignoreIncompatibleHint')} onClick={() => onIgnore(i)}>{t('ignoreIncompatible')}</button>}
            {i.fix === 'activate' && i.target && <button className="rl-btn rl-btn-sm rl-btn-primary" onClick={() => onActivate([i.target])}>{t('activate')} {i.targetName || i.target}</button>}
            {i.fix === 'replace' && i.installedKey && onReplace && <button className="rl-btn rl-btn-sm rl-btn-primary" title={t('replaceHint')} onClick={() => onReplace(i.mod, i.installedKey)}>⇄ {t('replaceWith')} {i.targetName || i.installedKey}</button>}
            {i.fix === 'subscribe' && i.steam?.pfid && <a className="rl-btn rl-btn-sm" href={workshopUrl(i.steam.pfid)} onClick={steamClick(i.steam.pfid)}>Steam ↗ {i.targetName || ''}</a>}
            {i.fix === 'subscribe' && !i.steam?.pfid && i.steam?.url && <a className="rl-btn rl-btn-sm" href={i.steam.url} target="_blank" rel="noreferrer">↗ {i.targetName || ''}</a>}
            {i.target && i.fix !== 'activate' && i.fix !== 'subscribe' && i.fix !== 'replace' && <button className="rl-btn rl-btn-sm rl-btn-ghost" onClick={() => onJump(i.target)}>→ {i.target}</button>}
          </div>
        )}
      </div>
    </div>
  )
}

export function DiagnosticsPanel({ diag, onJump, onActivate, onSort, onIgnore, onReplace }) {
  const [level, setLevel] = useState('all')
  if (!diag) return <div className="rl-loading">{t('loading')}</div>
  const issues = diag.issues.filter((i) => level === 'all' || i.level === level)
  return (
    <div className="rl-col" style={{ borderRight: 0 }}>
      <div className="rl-toolbar">
        {[['all', t('all'), diag.issues.length], ['error', t('errors'), diag.counts.error], ['warning', t('warnings'), diag.counts.warning], ['info', t('infos'), diag.counts.info]].map(([v, l, n]) => (
          <button key={v} className="rl-chip" aria-pressed={level === v} onClick={() => setLevel(v)}>{l} {n}</button>
        ))}
        <span style={{ flex: 1 }} />
        {diag.issues.some((i) => i.fix === 'sort') && <button className="rl-btn rl-btn-sm" onClick={onSort}>{t('sort')}</button>}
      </div>
      <div className="rl-list" style={{ padding: 0 }}>
        {issues.length ? issues.map((i, n) => <IssueRow key={n} issue={i} onJump={onJump} onActivate={onActivate} onIgnore={onIgnore} onReplace={onReplace} />) : <div className="rl-empty">{t('noIssues')}</div>}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- lists */
export function ListsPanel({ snap, active, catalog, actions, onJump }) {
  const [tab, setTab] = useState('saved') // saved | import | export
  const [lists, setLists] = useState(snap?.lists || [])
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [compare, setCompare] = useState(null)
  const [importText, setImportText] = useState('')
  const [importUrl, setImportUrl] = useState('')
  const [importName, setImportName] = useState('')
  const [importResult, setImportResult] = useState(null)
  const [exportFormat, setExportFormat] = useState('rimlist')
  const [exportText, setExportText] = useState('')
  const [exportFile, setExportFile] = useState('')
  const [exportListId, setExportListId] = useState('')
  const reload = async () => setLists(await api('lists'))
  useEffect(() => {
    setLists(snap?.lists || [])
  }, [snap])

  const saveCurrent = async () => {
    if (!name.trim()) return
    await actions.api('saveList', { name: name.trim(), description: desc, mods: active }, '✓')
    setName('')
    setDesc('')
    reload()
  }
  const doExport = async () => {
    const r = await actions.api('exportList', { id: exportListId || undefined, format: exportFormat })
    setExportText(r.text)
    setExportFile(r.filename)
  }
  const download = () => {
    const blob = new Blob([exportText], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = exportFile || 'modlist.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const doImport = async () => {
    const r = importUrl.trim() ? await actions.api('importUrl', { url: importUrl.trim(), name: importName || undefined }) : await actions.api('importText', { text: importText, name: importName || undefined })
    setImportResult(r)
    reload()
  }
  const [installRes, setInstallRes] = useState(null)
  const installMissing = async (listId) => {
    const r = await actions.api('installMissing', { id: listId })
    if (!r) return
    setInstallRes({ listId, ...r })
    if (r.cloned.length) actions.refresh()
  }
  const srcBadge = (m) => (m.git ? ' [git]' : m.publishedFileId ? ' [Steam]' : ' [?]')
  const MissingBox = ({ listId, mods }) => (
    <div className="rl-error">
      {t('missing')} ({mods.length}): {mods.map((m) => (m.name || m.packageId) + srcBadge(m)).join(', ')}
      {mods.some((m) => m.publishedFileId || m.git) && (
        <div style={{ marginTop: 6 }}>
          <button className="rl-btn rl-btn-sm" onClick={() => installMissing(listId)} title={t('installMissingTitle')}>{t('installMissing')} ↗</button>
        </div>
      )}
      {installRes?.listId === listId && (
        <div className="rl-muted" style={{ marginTop: 6 }}>
          {installRes.cloned.length > 0 && <div>✔ {t('gitCloned')}: {installRes.cloned.map((m) => m.name).join(', ')}</div>}
          {installRes.opened.length > 0 && <div>↗ {t('steamOpened')}: {installRes.opened.map((m) => m.name).join(', ')}</div>}
          {installRes.failed.length > 0 && <div>✖ {installRes.failed.map((m) => m.name + ' — ' + m.error).join('; ')}</div>}
          {installRes.manual.length > 0 && <div>? {t('noSource')}: {installRes.manual.map((m) => m.name).join(', ')}</div>}
          <div>{t('installThenApply')}</div>
        </div>
      )}
    </div>
  )

  return (
    <div className="rl-col" style={{ borderRight: 0 }}>
      <div className="rl-toolbar">
        <div className="rl-tabs">
          {[['saved', t('lists')], ['import', t('import')], ['export', t('export')]].map(([v, l]) => (
            <button key={v} className="rl-tab" aria-selected={tab === v} onClick={() => setTab(v)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="rl-side">
        {tab === 'saved' && (
          <>
            <div className="rl-card">
              <div className="rl-section-title">{t('saveList')}</div>
              <input className="rl-input" placeholder={t('listName')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveCurrent()} />
              <input className="rl-input" placeholder={t('listDesc')} value={desc} onChange={(e) => setDesc(e.target.value)} />
              <div className="rl-card-actions"><button className="rl-btn rl-btn-primary rl-btn-sm" disabled={!name.trim()} onClick={saveCurrent}>{t('save')} ({active.length} {t('mods')})</button></div>
            </div>
            {!lists.length && <div className="rl-empty">{t('noLists')}</div>}
            {lists.map((l) => (
              <div className="rl-card" key={l.id}>
                <div className="rl-card-title">
                  <b>{l.name}</b>
                  <small>{l.count} {t('mods')} · RW {l.gameVersion || '?'}{l.author ? ' · ' + l.author : ''}</small>
                </div>
                {l.description && <div className="rl-muted">{l.description}</div>}
                <div className="rl-card-actions">
                  <button className="rl-btn rl-btn-sm rl-btn-primary" onClick={async () => { const r = await actions.api('applyList', { id: l.id, mode: 'replace' }, t('applyReplace') + ' ✓'); actions.setOrderFromServer(r.active); if (r.missing.length) setCompare({ list: l, missingOnly: r.missing }) }}>{t('applyReplace')}</button>
                  <button className="rl-btn rl-btn-sm" onClick={async () => { const r = await actions.api('applyList', { id: l.id, mode: 'merge' }, t('applyMerge') + ' ✓'); actions.setOrderFromServer(r.active) }}>{t('applyMerge')}</button>
                  <button className="rl-btn rl-btn-sm" onClick={async () => setCompare(await actions.api('compareList', { id: l.id }))}>{t('compare')}</button>
                  <button className="rl-btn rl-btn-sm" onClick={() => { setExportListId(l.id); setTab('export') }}>{t('export')}</button>
                  <button className="rl-btn rl-btn-sm rl-btn-ghost rl-btn-danger" onClick={async () => { if (confirm(t('delete') + ' "' + l.name + '"?')) { await actions.api('deleteList', { id: l.id }); reload() } }}>{t('delete')}</button>
                </div>
                {compare && compare.list?.id === l.id && (
                  compare.missingOnly ? (
                    <MissingBox listId={l.id} mods={compare.missingOnly} />
                  ) : (
                    <DiffView d={compare} onJump={onJump} />
                  )
                )}
              </div>
            ))}
          </>
        )}
        {tab === 'import' && (
          <>
            <div className="rl-muted">{t('importHint')}</div>
            <input className="rl-input" placeholder={t('listName')} value={importName} onChange={(e) => setImportName(e.target.value)} />
            <input className="rl-input" placeholder={t('importUrl') + ' https://…'} value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
            <textarea className="rl-input rl-textarea" placeholder={t('importPaste')} value={importText} onChange={(e) => setImportText(e.target.value)} />
            <div className="rl-card-actions"><button className="rl-btn rl-btn-primary" disabled={!importText.trim() && !importUrl.trim()} onClick={doImport}>{t('doImport')}</button></div>
            {importResult && (
              <div className="rl-card">
                <div className="rl-card-title"><b>{importResult.name}</b><small>{importResult.mods.length} {t('mods')}{importResult.list ? ' · saved' : ''}</small></div>
                <DiffView d={{ added: importResult.diff.added.map((k) => ({ packageId: k, name: catalog.get(k)?.name || importResult.mods.find((m) => m.packageId.toLowerCase() === k)?.name || k, installed: catalog.has(k) })), removed: importResult.diff.removed.map((k) => ({ packageId: k, name: catalog.get(k)?.name || k, installed: true })), reordered: importResult.diff.reordered.map((k) => ({ packageId: k, name: catalog.get(k)?.name || k, installed: true })), same: importResult.diff.same }} onJump={onJump} />
                {importResult.missing.length > 0 && importResult.list && <MissingBox listId={importResult.list.id} mods={importResult.missing} />}
                {importResult.list && <div className="rl-card-actions"><button className="rl-btn rl-btn-sm rl-btn-primary" onClick={async () => { const r = await actions.api('applyList', { id: importResult.list.id, mode: 'replace' }, '✓'); actions.setOrderFromServer(r.active) }}>{t('applyReplace')}</button><button className="rl-btn rl-btn-sm" onClick={async () => { const r = await actions.api('applyList', { id: importResult.list.id, mode: 'merge' }, '✓'); actions.setOrderFromServer(r.active) }}>{t('applyMerge')}</button></div>}
              </div>
            )}
          </>
        )}
        {tab === 'export' && (
          <>
            <div className="rl-form-row">
              <select className="rl-select" value={exportListId} onChange={(e) => setExportListId(e.target.value)}>
                <option value="">{t('active')} ({active.length})</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.count})</option>)}
              </select>
              <select className="rl-select" value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
                <option value="rimlist">{t('formatRimlist')}</option>
                <option value="modsconfig">{t('formatModsconfig')}</option>
                <option value="ids">{t('formatIds')}</option>
                <option value="markdown">{t('formatMarkdown')}</option>
              </select>
              <button className="rl-btn rl-btn-primary" onClick={doExport}>{t('export')}</button>
            </div>
            {exportText && (
              <>
                <div className="rl-card-actions">
                  <button className="rl-btn rl-btn-sm" onClick={() => navigator.clipboard.writeText(exportText).then(() => actions.say(t('copied')))}>{t('copy')}</button>
                  <button className="rl-btn rl-btn-sm" onClick={download}>{t('download')} {exportFile}</button>
                </div>
                <pre className="rl-code">{exportText}</pre>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function DiffView({ d, onJump }) {
  const Col = ({ cls, title, items }) => (
    <div className={'rl-diff-col ' + cls}>
      <h4>{title} {items.length}</h4>
      <ul>{items.map((m) => <li key={m.packageId} className={m.installed === false ? 'rl-missing' : ''} title={m.packageId} onClick={() => m.installed !== false && onJump(m.packageId)}>{m.name}</li>)}</ul>
    </div>
  )
  return (
    <div>
      <div className="rl-muted" style={{ marginBottom: 6 }}>{t('same')}: {d.same}</div>
      <div className="rl-diff">
        <Col cls="rl-diff-add" title={t('added')} items={d.added} />
        <Col cls="rl-diff-rm" title={t('removed')} items={d.removed} />
        <Col cls="rl-diff-mv" title={t('reordered')} items={d.reordered} />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- rules */
const DB_ORDER = ['community', 'steam', 'noVersionWarning', 'useThisInstead', 'versions']
const DB_DESC = { community: 'dbCommunityDesc', steam: 'dbSteamDesc', noVersionWarning: 'dbNvwDesc', useThisInstead: 'dbUtiDesc', versions: 'dbVersionsDesc' }
const dbCount = (k, m) => (k === 'community' ? m.rules : k === 'noVersionWarning' ? m.ids : m.entries) ?? 0

function DatabaseCard({ k, meta, rimsort, actions, onChanged }) {
  const [mode, setMode] = useState(meta?.mode || 'github')
  const [url, setUrl] = useState(meta?.url || '')
  const [file, setFile] = useState(meta?.path || '')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  useEffect(() => {
    setMode(meta?.mode || 'github')
    setUrl(meta?.url || '')
    setFile(meta?.path || '')
  }, [meta?.mode, meta?.url, meta?.path])
  const dirty = mode !== (meta?.mode || 'github') || (mode === 'url' && url !== (meta?.url || '')) || (mode === 'local' && file !== (meta?.path || ''))
  const apply = async () => {
    setBusy(true)
    try {
      const r = await actions.api('configureDatabase', { key: k, mode, url, path: file })
      setResult(r.error ? { err: r.error } : { ok: true })
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  const refresh = async () => {
    setBusy(true)
    try {
      await actions.api('refreshRules', { key: k }, t('dbRefresh') + ' ✓')
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  const off = mode === 'none'
  const status = meta?.error ? 'err' : off ? 'off' : meta?.cached || dbCount(k, meta) ? 'ok' : 'warn'
  const opt = (v, label, hint) => (
    <label key={'o-' + v} className={'rl-radio' + (mode === v ? ' rl-radio-on' : '')}>
      <input type="radio" name={'db-' + k} checked={mode === v} onChange={() => setMode(v)} />
      <span className="rl-radio-dot" />
      <span className="rl-radio-label">{label}</span>
      {hint && <span className="rl-radio-hint">{hint}</span>}
    </label>
  )
  return (
    <div className={'rl-db' + (off ? ' rl-db-off' : '')}>
      <div className="rl-db-head">
        <span className={'rl-dot rl-dot-' + status} />
        <b>{meta?.label || k}</b>
        <span className="rl-db-count">{off ? t('dbOff') : `${dbCount(k, meta).toLocaleString()} ${t('entries')}`}</span>
        <span className="rl-db-time">{meta?.fetchedAt ? new Date(meta.fetchedAt).toLocaleDateString() : off ? '' : t('dbNotCached')}</span>
        <button className="rl-icon-btn" title={t('dbRefresh')} disabled={busy || off} onClick={refresh}>↻</button>
      </div>
      <div className="rl-db-desc">{t(DB_DESC[k])}</div>
      <div className="rl-db-opts">
        {opt('none', t('dbNone'), t('dbNoneHint'))}
        {opt('github', t('dbGithub'), <a href={meta?.repo} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{(meta?.repo || '').replace('https://github.com/', '')}</a>)}
        {opt('url', t('dbUrl'))}
        {mode === 'url' && <input className="rl-input rl-db-input" placeholder={meta?.defaultUrl || 'https://…'} value={url} onChange={(e) => setUrl(e.target.value)} />}
        {opt('local', t('dbLocal'))}
        {mode === 'local' && (
          <div className="rl-db-input">
            <input className="rl-input" placeholder={rimsort?.[k] || '/path/to/file'} value={file} onChange={(e) => setFile(e.target.value)} />
            {rimsort?.[k] && file !== rimsort[k] && <button className="rl-btn rl-btn-sm rl-btn-ghost" onClick={() => setFile(rimsort[k])}>{t('dbUseRimsort')}</button>}
          </div>
        )}
      </div>
      {(dirty || result) && (
        <div className="rl-db-foot">
          {result?.err && <span className="rl-db-err">✖ {result.err}</span>}
          {result?.ok && !dirty && <span className="rl-db-ok">✓ {t('dbOk')}</span>}
          {dirty && <button className="rl-btn rl-btn-sm rl-btn-primary" disabled={busy} onClick={apply}>{t('dbApply')}</button>}
        </div>
      )}
      {meta?.error && !result && <div className="rl-db-err">✖ {meta.error}</div>}
    </div>
  )
}

export function RulesPanel({ snap, catalog, actions, selectedKey, selection, activeOrder }) {
  const [sub, setSub] = useState('custom') // custom | databases
  const [rules, setRules] = useState({})
  const [pkg, setPkg] = useState(selectedKey || '')
  const [kind, setKind] = useState('loadAfter')
  const [target, setTarget] = useState('')
  const [comment, setComment] = useState('')
  const [rimsort, setRimsort] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const reload = () => api('userRules').then(setRules)
  useEffect(() => {
    reload()
    api('rimsortPaths').then(setRimsort).catch(() => {})
  }, [])
  useEffect(() => {
    if (selectedKey) setPkg(selectedKey)
  }, [selectedKey])
  const st = snap?.rules
  const nameOf = (k) => catalog.get(k)?.name || k
  const add = async () => {
    await actions.api('addRule', { packageId: pkg, kind, target, comment, name: catalog.get(target)?.name }, '✓')
    setTarget('')
    setComment('')
    reload()
    actions.refresh()
  }
  const selectedActive = selection?.side === 'active' ? [...selection.keys] : []
  const pin = async () => {
    if (selectedActive.length < 2) return actions.say(t('selectTwo'))
    const ordered = [...selectedActive].sort((a, b) => activeOrder.indexOf(a) - activeOrder.indexOf(b)) // draft order shown in the list
    await actions.api('pinOrder', { ids: ordered, ordered: true, comment: 'pinned from UI' }, t('pinOrderDone'))
    reload()
    actions.refresh()
  }
  const doImport = async () => {
    const r = importText.trim().startsWith('{') ? await actions.api('importUserRules', { text: importText }) : await actions.api('importUserRules', { path: importText.trim() || rimsort?.userRules })
    actions.say(`${t('rulesImported')}: ${r.imported}`)
    setImportOpen(false)
    setImportText('')
    reload()
    actions.refresh()
  }
  const doExport = async () => {
    const r = await actions.api('exportUserRules')
    await navigator.clipboard.writeText(r.text)
    actions.say(t('copied'))
  }
  const communityFor = (k) => catalog.get(k)?.rules
  const ruleCount = Object.keys(rules).length

  return (
    <div className="rl-col" style={{ borderRight: 0 }}>
      <div className="rl-toolbar">
        <div className="rl-tabs" style={{ flex: 1 }}>
          <button className="rl-tab" aria-selected={sub === 'custom'} onClick={() => setSub('custom')} style={{ flex: 1 }}>{t('userRules')} {ruleCount ? <span className="rl-badge">{ruleCount}</span> : null}</button>
          <button className="rl-tab" aria-selected={sub === 'databases'} onClick={() => setSub('databases')} style={{ flex: 1 }}>{t('databases')}</button>
        </div>
      </div>
      <div className="rl-side">
        {sub === 'custom' && (
          <>
            <div className="rl-muted">{t('userRulesDesc')}</div>

            <div className="rl-card rl-card-accent">
              <div className="rl-card-title"><b>{t('pinOrder')}</b><small>{selectedActive.length ? `${selectedActive.length} ${t('mods')}` : ''}</small></div>
              <div className="rl-muted">{t('pinOrderHint')}</div>
              {selectedActive.length >= 2 && (
                <ol className="rl-chain">
                  {[...selectedActive].sort((a, b) => activeOrder.indexOf(a) - activeOrder.indexOf(b)).map((k) => <li key={k}>{nameOf(k)}</li>)}
                </ol>
              )}
              <div className="rl-card-actions"><button className="rl-btn rl-btn-sm rl-btn-primary" disabled={selectedActive.length < 2} onClick={pin}>⇅ {t('pinOrder')}</button></div>
            </div>

            <div className="rl-card">
              <div className="rl-card-title"><b>{t('addRule')}</b></div>
              <ModPicker catalog={catalog} value={pkg} onChange={setPkg} placeholder="packageId" />
              <div className="rl-form-row">
                <select className="rl-select" value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="loadAfter">loadAfter</option>
                  <option value="loadBefore">loadBefore</option>
                  <option value="incompatibleWith">incompatibleWith</option>
                  <option value="ignoreIncompatible">ignoreIncompatible</option>
                  <option value="loadTop">loadTop</option>
                  <option value="loadBottom">loadBottom</option>
                </select>
                {kind !== 'loadTop' && kind !== 'loadBottom' && <div style={{ flex: 1, minWidth: 160 }}><ModPicker catalog={catalog} value={target} onChange={setTarget} placeholder={t('ruleTarget')} /></div>}
              </div>
              <input className="rl-input" placeholder={t('ruleComment')} value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="rl-card-actions"><button className="rl-btn rl-btn-primary rl-btn-sm" disabled={!pkg || (kind !== 'loadTop' && kind !== 'loadBottom' && !target)} onClick={add}>{t('addRule')}</button></div>
            </div>

            <div className="rl-section-title">{t('userRules')} ({ruleCount})</div>
            <div className="rl-card-actions">
              <button className="rl-btn rl-btn-sm" onClick={() => setImportOpen((v) => !v)}>{t('importRules')}</button>
              <button className="rl-btn rl-btn-sm" disabled={!ruleCount} onClick={doExport}>{t('exportRules')}</button>
            </div>
            {importOpen && (
              <div className="rl-card">
                <textarea className="rl-input rl-textarea" placeholder={rimsort?.userRules ? `${rimsort.userRules}\n\n(${t('importPaste')} JSON ${t('all').toLowerCase()})` : '{ "rules": { … } }'} value={importText} onChange={(e) => setImportText(e.target.value)} />
                <div className="rl-card-actions">
                  <button className="rl-btn rl-btn-sm rl-btn-primary" disabled={!importText.trim() && !rimsort?.userRules} onClick={doImport}>{t('import')}</button>
                  {rimsort?.userRules && !importText.trim() && <span className="rl-muted">→ {rimsort.userRules}</span>}
                </div>
              </div>
            )}
            {!ruleCount && <div className="rl-empty">{t('noUserRules')}</div>}
            {Object.entries(rules).map(([k, r]) => (
              <div className="rl-card" key={k}>
                <div className="rl-card-title"><b>{nameOf(k)}</b><small>{k}</small></div>
                <div className="rl-rule-list">
                  {r.loadTop && <RuleLine kind="loadTop" onRemove={() => actions.api('removeRule', { packageId: k, kind: 'loadTop' }).then(() => { reload(); actions.refresh() })} />}
                  {r.loadBottom && <RuleLine kind="loadBottom" onRemove={() => actions.api('removeRule', { packageId: k, kind: 'loadBottom' }).then(() => { reload(); actions.refresh() })} />}
                  {['loadAfter', 'loadBefore', 'incompatibleWith', 'ignoreIncompatible'].flatMap((f) => Object.entries(r[f] || {}).map(([tk, info]) => {
                    const c = communityFor(k)
                    const opp = f === 'loadAfter' ? 'loadBefore' : f === 'loadBefore' ? 'loadAfter' : null
                    const overrides = opp && c && c[opp] && c[opp][tk] && c[opp][tk].source === 'community'
                    return <RuleLine key={f + tk} kind={f} target={nameOf(tk)} comment={info.comment} overrides={overrides} onRemove={() => actions.api('removeRule', { packageId: k, kind: f, target: tk }).then(() => { reload(); actions.refresh() })} />
                  }))}
                </div>
              </div>
            ))}
          </>
        )}
        {sub === 'databases' && (
          <>
            {rimsort?.base && <div className="rl-muted">✓ {t('dbRimsortFound')}: <span style={{ fontFamily: 'var(--rl-mono)' }}>{rimsort.base}</span></div>}
            {DB_ORDER.map((k) => <DatabaseCard key={k} k={k} meta={st?.[k]} rimsort={rimsort} actions={actions} onChanged={actions.refresh} />)}
            <div className="rl-card-actions"><button className="rl-btn" onClick={actions.refreshRules}>↻ {t('dbRefreshAll')}</button></div>
          </>
        )}
      </div>
    </div>
  )
}

function RuleLine({ kind, target, comment, overrides, onRemove }) {
  return (
    <div className="rl-rule">
      <span className={'rl-tag rl-tag-' + (kind === 'incompatibleWith' ? 'err' : kind === 'ignoreIncompatible' ? 'ok' : kind === 'loadTop' || kind === 'loadBottom' ? 'core' : 'info')}>{kind}</span>
      {target && <span className="rl-rule-target">{target}</span>}
      {overrides && <span className="rl-tag rl-tag-warn" title={t('overrideNote')}>override</span>}
      {comment && <span className="rl-rule-comment">{comment}</span>}
      <button className="rl-icon-btn rl-rule-x" onClick={onRemove} title={t('delete')}>×</button>
    </div>
  )
}

function ModPicker({ catalog, value, onChange, placeholder }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return [...catalog.values()].filter((m) => m.name.toLowerCase().includes(s) || m.key.includes(s)).slice(0, 12)
  }, [q, catalog])
  const shown = value && !open ? `${catalog.get(value)?.name || value} (${value})` : q
  return (
    <div style={{ position: 'relative' }}>
      <input className="rl-input" placeholder={placeholder} value={shown} onFocus={() => { setOpen(true); setQ('') }} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => { setQ(e.target.value); onChange(e.target.value.trim()) }} />
      {open && list.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 3, left: 0, right: 0, top: '100%', background: 'var(--rl-bg2)', border: '1px solid var(--rl-line2)', borderRadius: 4, maxHeight: 220, overflow: 'auto' }}>
          {list.map((m) => (
            <div key={m.key} className="rl-row" style={{ gridTemplateColumns: '1fr', cursor: 'pointer' }} onMouseDown={() => { onChange(m.key); setOpen(false) }}>
              <div className="rl-row-main"><div className="rl-row-name"><span>{m.name}</span></div><div className="rl-row-sub">{m.key}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ launch */
function LaunchSettings({ snap, actions }) {
  const init = snap?.settings?.launch || {}
  const [cfg, setCfg] = useState({ mode: 'steam', steamPath: '', executable: '', command: '', args: '', saveFirst: true, ...init })
  const [preview, setPreview] = useState(null)
  useEffect(() => {
    const id = setTimeout(() => api('launchPreview', { launch: cfg }).then(setPreview).catch(() => {}), 250)
    return () => clearTimeout(id)
  }, [JSON.stringify(cfg)])
  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }))
  const save = async () => {
    await actions.api('setSettings', { launch: cfg }, '✓')
    actions.refresh()
  }
  const plat = preview?.platform
  const exeHint = plat === 'win32' ? 'RimWorldWin64.exe' : plat === 'darwin' ? 'RimWorldMac.app' : 'RimWorldLinux'
  const steamHint = plat === 'win32' ? 'C:\\Program Files (x86)\\Steam\\steam.exe' : plat === 'darwin' ? '/Applications/Steam.app/Contents/MacOS/steam_osx' : 'steam'
  const opt = (v, label, hint) => (
    <label key={'l-' + v} className={'rl-radio' + (cfg.mode === v ? ' rl-radio-on' : '')}>
      <input type="radio" name="rl-launch" checked={cfg.mode === v} onChange={() => set('mode', v)} />
      <span className="rl-radio-dot" />
      <span className="rl-radio-label">{label}</span>
      <span className="rl-radio-hint">{hint}</span>
    </label>
  )
  const changed = JSON.stringify(cfg) !== JSON.stringify({ mode: 'steam', steamPath: '', executable: '', command: '', args: '', saveFirst: true, ...init })
  return (
    <>
      <div className="rl-section-title">{t('launchSettings')}</div>
      <div className="rl-db">
        <div className="rl-db-opts">
          {opt('steam', 'Steam', t('launchSteamHint'))}
          {cfg.mode === 'steam' && <div className="rl-db-input"><input className="rl-input" placeholder={`${t('launchSteamPath')} — ${steamHint}`} value={cfg.steamPath} onChange={(e) => set('steamPath', e.target.value)} /></div>}
          {opt('direct', t('launchDirect'), preview?.detectedExecutable || exeHint)}
          {cfg.mode === 'direct' && <div className="rl-db-input"><input className="rl-input" placeholder={preview?.detectedExecutable ? `${t('autoDetected')}: ${preview.detectedExecutable}` : exeHint} value={cfg.executable} onChange={(e) => set('executable', e.target.value)} /></div>}
          {opt('custom', t('launchCustom'), t('launchCustomHint'))}
          {cfg.mode === 'custom' && <div className="rl-db-input"><input className="rl-input" placeholder={plat === 'linux' ? 'flatpak run com.valvesoftware.Steam -applaunch 294100' : '"C:\\path\\to\\app.exe" --flag'} value={cfg.command} onChange={(e) => set('command', e.target.value)} /></div>}
        </div>
        <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <div className="rl-muted" style={{ marginBottom: 3 }}>{t('launchArgs')}</div>
            <input className="rl-input" style={{ fontFamily: 'var(--rl-mono)', fontSize: 12 }} placeholder="-logfile /tmp/rimworld.log  -savedatafolder=…" value={cfg.args} onChange={(e) => set('args', e.target.value)} />
          </div>
          <label className="rl-form-row" style={{ fontSize: 12.5, cursor: 'pointer' }}>
            <input type="checkbox" checked={cfg.saveFirst !== false} onChange={(e) => set('saveFirst', e.target.checked)} /> {t('launchSaveFirst')}
          </label>
          <div className="rl-muted" style={{ fontFamily: 'var(--rl-mono)', fontSize: 11, wordBreak: 'break-all' }}>
            {preview?.error ? <span style={{ color: 'var(--rl-err)' }}>✖ {preview.error}</span> : preview?.command ? <>$ {preview.command}</> : '…'}
            {preview?.note && <div style={{ color: 'var(--rl-warn)' }}>{preview.note}</div>}
          </div>
        </div>
        <div className="rl-db-foot">
          <button className="rl-btn rl-btn-sm" disabled={!!preview?.error} onClick={async () => { if (changed) await save(); const r = await actions.api('launch', {}); actions.say(t('launched')) }}>▶ {t('launchTest')}</button>
          <button className="rl-btn rl-btn-sm rl-btn-primary" disabled={!changed} onClick={save}>{t('saveSettings')}</button>
        </div>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------- sort */
function SortSettings({ snap, actions }) {
  const cur = snap?.settings?.sortTieBreak || 'name'
  const pick = async (v) => {
    if (v === cur) return
    await actions.api('setSettings', { sortTieBreak: v }, '✓')
    actions.refresh()
  }
  const opt = (v, label, hint) => (
    <label key={'tb-' + v} className={'rl-radio' + (cur === v ? ' rl-radio-on' : '')}>
      <input type="radio" name="rl-tiebreak" checked={cur === v} onChange={() => pick(v)} />
      <span className="rl-radio-dot" />
      <span className="rl-radio-label">{label}</span>
      <span className="rl-radio-hint">{hint}</span>
    </label>
  )
  return (
    <>
      <div className="rl-section-title">{t('sortSettings')}</div>
      <div className="rl-db">
        <div className="rl-muted" style={{ padding: '10px 12px 0' }}>{t('tieBreak')}</div>
        <div className="rl-db-opts">
          {opt('name', t('tieBreakName'), t('tieBreakNameHint'))}
          {opt('current', t('tieBreakCurrent'), t('tieBreakCurrentHint'))}
          {opt('rimsort', t('tieBreakRimsort'), t('tieBreakRimsortHint'))}
        </div>
        <div className="rl-muted" style={{ padding: '0 12px 10px', fontSize: 11.5 }}>{t('sortPriorityChain').replace('{tb}', cur === 'name' ? t('tieBreakName') : cur === 'rimsort' ? t('tieBreakRimsort') : t('tieBreakCurrent'))}</div>
      </div>
    </>
  )
}

function WorkshopOpenSetting({ snap, actions }) {
  const cur = snap?.settings?.workshopOpen === 'browser' ? 'browser' : 'steam'
  const pick = async (v) => {
    if (v === cur) return
    await actions.api('setSettings', { workshopOpen: v }, '✓')
    actions.refresh()
  }
  const opt = (v, label, hint) => (
    <label key={'wo-' + v} className={'rl-radio' + (cur === v ? ' rl-radio-on' : '')}>
      <input type="radio" name="rl-workshop-open" checked={cur === v} onChange={() => pick(v)} />
      <span className="rl-radio-dot" />
      <span className="rl-radio-label">{label}</span>
      <span className="rl-radio-hint">{hint}</span>
    </label>
  )
  return (
    <>
      <div className="rl-section-title">{t('workshopOpen')}</div>
      <div className="rl-db">
        <div className="rl-db-opts">
          {opt('steam', t('workshopOpenSteam'), t('workshopOpenSteamHint'))}
          {opt('browser', t('workshopOpenBrowser'), t('workshopOpenBrowserHint'))}
        </div>
      </div>
    </>
  )
}

function TagSettings({ actions }) {
  const [onlyActive, setOnlyActive] = useState(true)
  const [classifying, setClassifying] = useState(false)
  const askAI = async () => {
    const how = await sendToChat(t('tagReviewPrompt').replace('{scope}', onlyActive ? t('tagScopeActive') : t('tagScopeAll')).replace('{args}', 'filter=auto, activeOnly=' + onlyActive))
    actions.say(how === 'inserted' ? t('logInserted') : t('logCopiedForChat'))
  }
  const classifyAll = async () => {
    setClassifying(true)
    try {
      const r = await actions.api('classifyAll', { activeOnly: onlyActive })
      actions.say(t('classifyAllDone') + ` (${r?.tags?.length || 0} ${t('mods')})`)
      actions.refresh()
    } catch (err) {
      actions.say('❌ ' + (err.message || 'Error'))
    } finally {
      setClassifying(false)
    }
  }
  const resetAll = async () => {
    if (!confirm(t('resetAllTagsConfirm'))) return
    const r = await actions.api('resetAllTags', {})
    if (r) actions.say(t('resetAllTagsDone').replace('{n}', r.removed))
    actions.refresh()
  }
  return (
    <>
      <div className="rl-section-title">{t('tagsSection')}</div>
      <div className="rl-muted">{t('tagsSectionHint')}</div>
      <label className="rl-form-row"><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> {t('tagScopeActiveOnly')}</label>
      <div className="rl-card-actions">
        <button className="rl-btn rl-btn-primary" onClick={classifyAll} disabled={classifying} title={t('classifyAllTitle')}>{classifying ? '⏳' : '⚙'} {t('classifyAll')}</button>
        <button className="rl-btn rl-btn-ai" onClick={askAI} title={t('tagReviewTitle')}>✦ {t('tagReview')}</button>
        <button className="rl-btn rl-btn-danger" onClick={resetAll}>↺ {t('resetAllTags')}</button>
      </div>
    </>
  )
}

/* ----------------------------------------------------------------- settings */
export function SettingsPanel({ snap, actions }) {
  const s = snap?.settings || {}
  const d = { ...(snap?.discovered || {}), savesDir: s.savesDir ? null : snap?.paths?.savesDir }
  const [form, setForm] = useState({ gameDir: s.gameDir || '', configDir: s.configDir || '', workshopDir: s.workshopDir || '', localModsDir: s.localModsDir || '', savesDir: s.savesDir || '', authorName: s.authorName || '' })
  const [backups, setBackups] = useState([])
  useEffect(() => {
    api('backups').then(setBackups).catch(() => {})
  }, [snap])
  const Field = ({ k, label }) => (
    <div>
      <div className="rl-muted" style={{ marginBottom: 3 }}>{label}</div>
      <input className="rl-input" value={form[k]} placeholder={d[k] ? `${t('autoDetected')}: ${d[k]}` : ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </div>
  )
  const save = async () => {
    const patch = {}
    for (const k of Object.keys(form)) patch[k] = form[k].trim() || null
    await actions.api('setSettings', patch, '✓')
    actions.refresh()
  }
  return (
    <div className="rl-side">
      <div className="rl-section-title">{t('settings')}</div>
      <Field k="gameDir" label={t('gameDir')} />
      <Field k="configDir" label={t('configDir')} />
      <Field k="workshopDir" label={t('workshopDir')} />
      <Field k="localModsDir" label={t('localModsDir')} />
      <Field k="savesDir" label={t('savesDir')} />
      <Field k="authorName" label={t('authorName')} />
      <div className="rl-card-actions"><button className="rl-btn rl-btn-primary" onClick={save}>{t('saveSettings')}</button><button className="rl-btn" onClick={actions.rescan}>{t('rescan')}</button></div>
      <div className="rl-muted">RimWorld {snap?.game?.full || '—'} · ModsConfig: {snap?.modsConfigPath || '—'}</div>

      <div className="rl-section-title">{t('dataDirectory')}</div>
      <div className="rl-muted" style={{ marginBottom: 8 }}>{t('dataDirectoryDesc')}</div>
      <div style={{ padding: '10px 12px', background: 'var(--rl-info-bg)', borderRadius: 6, fontFamily: 'var(--rl-mono)', fontSize: 12, wordBreak: 'break-all', marginBottom: 10 }}>
        {snap?.dataDir || '~/.dsh/rimlist'}
      </div>
      <div className="rl-muted" style={{ fontSize: 11.5 }}>
        {t('dataDirectoryNote')}
      </div>

      <SortSettings snap={snap} actions={actions} />

      <WorkshopOpenSetting snap={snap} actions={actions} />


      <TagSettings actions={actions} />

      <LaunchSettings snap={snap} actions={actions} />

      <div className="rl-section-title">{t('backups')} ({backups.length})</div>
      {backups.slice(0, 15).map((b) => (
        <div className="rl-form-row" key={b.name} style={{ justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--rl-mono)', fontSize: 12 }}>{b.name.replace(/^ModsConfig\.|\.xml$/g, '')} <span className="rl-muted">{(b.size / 1024).toFixed(1)} KB</span></span>
          <button className="rl-btn rl-btn-sm" onClick={async () => { if (confirm(t('restore') + ' ' + b.name + '?')) { const r = await actions.api('restoreBackup', { name: b.name }, '✓'); actions.setOrderFromServer(r.active) } }}>{t('restore')}</button>
        </div>
      ))}
    </div>
  )
}
