import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { t } from './i18n.js'
import { sendToChat } from './chat.js'

const POLL_MS = 3000

/** RimWorld Player.log viewer: auto-reloads when the game writes a new log, filters, and hands a summary to the AI. */
export function LogPanel({ catalog, onJump, say }) {
  const [previous, setPrevious] = useState(false)
  const [data, setData] = useState(null)
  const [level, setLevel] = useState('error')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(() => new Set())
  const [follow, setFollow] = useState(true)
  const [fresh, setFresh] = useState(false)
  const stamp = useRef('')
  const listRef = useRef(null)

  const load = async () => {
    const r = await api('readLog', { previous })
    stamp.current = r.path ? `${r.path}|${r.size}|${r.mtime}` : ''
    setData(r)
  }
  useEffect(() => {
    let alive = true
    stamp.current = ''
    setData(null)
    load().catch((e) => setData({ error: String(e.message || e), entries: [] }))
    // Auto-reload: poll size/mtime; a new game run rewrites Player.log.
    const id = setInterval(async () => {
      if (!alive || document.hidden) return
      try {
        const i = await api('logInfo', { previous })
        const s = i.path ? `${i.path}|${i.size}|${i.mtime}` : ''
        if (s && s !== stamp.current) {
          await load()
          setFresh(true)
          setTimeout(() => alive && setFresh(false), 1500)
        }
      } catch {}
    }, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [previous])

  const entries = useMemo(() => {
    if (!data?.entries) return []
    const needle = q.trim().toLowerCase()
    const rank = { error: 0, warning: 1, info: 2 }
    const max = level === 'all' ? 2 : rank[level]
    const seen = new Set()
    const out = []
    for (const e of data.entries) {
      if (rank[e.level] > max) continue
      if (needle && !(e.line.toLowerCase().includes(needle) || e.mods.some((k) => (catalog.get(k)?.name || k).toLowerCase().includes(needle)))) continue
      // collapse repeats of the same message (count shown as ×N)
      if (e.count > 1 && e.level !== 'info') {
        const k = e.pattern || e.level + e.line
        if (seen.has(k)) continue
        seen.add(k)
      }
      out.push(e)
    }
    return out
  }, [data, level, q, catalog])

  useEffect(() => {
    if (follow && listRef.current && level === 'all') listRef.current.scrollTop = listRef.current.scrollHeight
  }, [entries, follow, level])

  const toAI = async (mode) => {
    const lv = level === 'error' ? 'error' : 'warning'
    if (mode === 'copy') {
      const r = await api('logSummary', { previous, level: lv })
      await navigator.clipboard.writeText(r.text)
      say(t('logCopied'))
      return
    }
    // Short instruction only: the AI reads the log itself via rimlist_game_log,
    // so the chat box never gets a huge paste.
    const args = `level=${lv}${previous ? ', previous=true' : ''}`
    const how = await sendToChat(t('logPrompt').replace('{args}', args))
    say(how === 'inserted' ? t('logInserted') : t('logCopiedForChat'))
  }

  if (!data) return <div className="rl-loading">{t('loading')}</div>
  if (!data.path) return <div className="rl-empty">{data.error || t('logNotFound')}</div>
  const tot = data.totals || { error: 0, warning: 0, info: 0 }
  const toggle = (i) => setOpen((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n })
  return (
    <div className="rl-col" style={{ borderRight: 0 }}>
      <div className="rl-toolbar rl-log-bar">
        {[['error', t('errors'), tot.error], ['warning', t('logErrWarn'), tot.error + tot.warning], ['all', t('all'), tot.error + tot.warning + tot.info]].map(([v, l, n]) => (
          <button key={v} className="rl-chip" aria-pressed={level === v} onClick={() => setLevel(v)}>{l} {n}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="rl-btn rl-btn-sm rl-btn-ai" onClick={() => toAI('chat')} title={t('logToAITitle')}>✦ {t('logToAI')}</button>
      </div>
      <div className="rl-toolbar">
        <input className="rl-input" placeholder={t('logFilter')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="rl-chip" aria-pressed={previous} onClick={() => setPrevious(!previous)} title="Player-prev.log">{t('logPrev')}</button>
        <button className="rl-btn rl-btn-sm" onClick={() => toAI('copy')} title={t('logCopyTitle')}>⧉</button>
        <button className="rl-btn rl-btn-sm" onClick={load} title={t('refresh')}>↻</button>
      </div>
      <div className={'rl-log-meta' + (fresh ? ' rl-log-fresh' : '')}>
        <span className="rl-log-live" title={t('logAuto')} /> {new Date(data.mtime).toLocaleString()} · {(data.size / 1024).toFixed(0)} KB{data.truncated ? ' · ' + t('logTruncated') : ''}
        {level === 'all' && <label style={{ marginLeft: 'auto', cursor: 'pointer' }}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {t('logFollow')}</label>}
      </div>
      <div className="rl-list rl-log" ref={listRef}>
        {entries.length === 0 && <div className="rl-empty">{level === 'error' ? t('logNoErrors') : t('noIssues')}</div>}
        {entries.map((e, i) => (
          <div key={i} className={'rl-log-row rl-log-' + e.level} onClick={() => e.trace.length && toggle(i)}>
            <div className="rl-log-line">
              {e.trace.length > 0 && <span className="rl-log-caret">{open.has(i) ? '▾' : '▸'}</span>}
              {e.count > 1 && e.level !== 'info' && <span className="rl-log-count">×{e.count}</span>}
              <span className="rl-log-text">{e.line}</span>
            </div>
            {e.mods.length > 0 && (
              <div className="rl-log-mods">
                {e.mods.slice(0, 4).map((k) => (
                  <button key={k} className="rl-log-mod" onClick={(ev) => { ev.stopPropagation(); onJump(k) }}>{catalog.get(k)?.name || k}</button>
                ))}
              </div>
            )}
            {open.has(i) && <pre className="rl-log-trace">{e.trace.join('\n')}</pre>}
          </div>
        ))}
      </div>
    </div>
  )
}
