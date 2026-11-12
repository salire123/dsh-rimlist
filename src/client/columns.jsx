import { useMemo, useRef, useState } from 'react'
import { t } from './i18n.js'

const Icon = {
  right: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M9 6l6 6-6 6" /></svg>,
  left: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 6l-6 6 6 6" /></svg>,
  top: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 15l6-6 6 6M5 4h14" /></svg>,
  bottom: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6M5 20h14" /></svg>,
}

const sourceTag = (m) => (m.kind === 'core' ? 'core' : m.kind === 'expansion' ? 'dlc' : m.source === 'workshop' ? 'ws' : 'local')

/**
 * Arrow-key navigation for a list of keys (visible order).
 * ↑/↓ move, Shift extends from the anchor, Home/End jump. Returns true when handled.
 */
export function navKey(e, keys, selection, side, setSelection) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key) || !keys.length) return false
  const mine = selection.side === side
  // "cursor" = the last row the user moved to (stored as focus), falling back to the anchor
  const cur = mine ? (selection.focus ?? selection.anchor) : null
  let i = cur != null ? keys.indexOf(cur) : -1
  const step = e.key === 'PageUp' || e.key === 'PageDown' ? 10 : 1
  if (e.key === 'Home') i = 0
  else if (e.key === 'End') i = keys.length - 1
  else if (i < 0) i = e.key === 'ArrowUp' || e.key === 'PageUp' ? keys.length - 1 : 0
  else i = Math.max(0, Math.min(keys.length - 1, i + (e.key === 'ArrowUp' || e.key === 'PageUp' ? -step : step)))
  const k = keys[i]
  if (e.shiftKey && mine && selection.anchor && keys.includes(selection.anchor)) {
    const a = keys.indexOf(selection.anchor)
    const [lo, hi] = a < i ? [a, i] : [i, a]
    setSelection({ keys: new Set(keys.slice(lo, hi + 1)), anchor: selection.anchor, focus: k, side })
  } else setSelection({ keys: new Set([k]), anchor: k, focus: k, side })
  e.preventDefault()
  scrollRowIntoView(e.currentTarget, k)
  return true
}

export function scrollRowIntoView(list, key) {
  requestAnimationFrame(() => list?.querySelector(`.rl-row[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' }))
}

/** Tag dropdown used in both column toolbars. */
export function TagFilter({ allTags, tag, setTag, tagIndex }) {
  return (
    <select className="rl-select rl-tag-select" value={tag} onChange={(e) => setTag(e.target.value)} title={t('filterByTag')} disabled={!tagIndex}>
      <option value="">{tagIndex ? t('allTags') : t('tagsLoading')}</option>
      {allTags.map(([g, n]) => <option key={g} value={g}>{g} ({n})</option>)}
    </select>
  )
}
const hasTag = (tagIndex, key, tag) => !tag || !!tagIndex?.[key]?.tags?.includes(tag)

export function ModRow({ mod, index, selected, issues, onSelect, onPrimary, primaryIcon, extra, dragProps, major }) {
  const worst = issues?.some((i) => i.level === 'error') ? 'err' : issues?.some((i) => i.level === 'warning') ? 'warn' : null
  const noVersion = major && mod.kind === 'mod' && !mod.supportedVersions.includes(major)
  return (
    <div
      className={'rl-row' + (worst ? ' rl-has-' + worst : '') + (dragProps?.className || '')}
      aria-selected={selected}
      data-key={mod.key}
      onClick={(e) => {
        onSelect(mod.key, e)
        e.currentTarget.closest('.rl-list')?.focus({ preventScroll: true })
      }}
      onDoubleClick={() => onPrimary(mod.key)}
      title={mod.packageId}
      {...(dragProps?.handlers || {})}
      draggable
    >
      <div className="rl-num">{index !== undefined ? index + 1 : ''}</div>
      <div className="rl-row-main">
        <div className="rl-row-name">
          <span>{mod.name}</span>
          <span className="rl-row-flags">
            <span className={'rl-tag' + (mod.kind !== 'mod' ? ' rl-tag-core' : '')}>{sourceTag(mod)}</span>
            {noVersion && <span className={'rl-tag ' + (mod.nvw ? 'rl-tag-info' : 'rl-tag-warn')} title={mod.nvw ? t('nvw') : mod.supportedVersions.join(', ')}>{mod.nvw ? 'nvw' : mod.supportedVersions.slice(-1)[0] || '?'}</span>}
            {worst === 'err' && <span className="rl-tag rl-tag-err">!</span>}
          </span>
        </div>
        <div className="rl-row-sub">{mod.author ? mod.author + ' · ' : ''}{mod.packageId}</div>
      </div>
      <div className="rl-row-act" onClick={(e) => e.stopPropagation()}>
        {extra}
        <button className="rl-icon-btn" onClick={() => onPrimary(mod.key)} title={primaryIcon === 'left' ? t('deactivate') : t('activate')}>
          {primaryIcon === 'left' ? <Icon.left /> : <Icon.right />}
        </button>
      </div>
    </div>
  )
}

/**
 * Active column with HTML5 drag & drop reordering and multi-select.
 */
export function ActiveColumn({ mods, catalog, order, issuesByMod, selection, setSelection, onDeactivate, onMove, onReorder, onDropFromInactive, major, filter, setFilter, tagIndex, allTags = [], tag = '', setTag = () => {} }) {
  const [drag, setDrag] = useState(null) // { keys: [], over: key, pos: 'before'|'after' }
  const listRef = useRef(null)
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return order.filter((k) => {
      if (!hasTag(tagIndex, k, tag)) return false
      const m = catalog.get(k)
      if (!m) return !q || k.includes(q)
      return !q || m.name.toLowerCase().includes(q) || k.includes(q) || (m.author || '').toLowerCase().includes(q)
    })
  }, [order, catalog, filter, tagIndex, tag])

  const select = (key, e) => {
    if (e.shiftKey && selection.anchor) {
      const a = order.indexOf(selection.anchor)
      const b = order.indexOf(key)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelection({ keys: new Set(order.slice(lo, hi + 1)), anchor: selection.anchor, focus: key, side: 'active' })
    } else if (e.ctrlKey || e.metaKey) {
      const keys = new Set(selection.side === 'active' ? selection.keys : [])
      keys.has(key) ? keys.delete(key) : keys.add(key)
      setSelection({ keys, anchor: key, side: 'active' })
    } else setSelection({ keys: new Set([key]), anchor: key, side: 'active' })
  }

  const handlersFor = (key) => ({
    onDragStart: (e) => {
      const keys = selection.side === 'active' && selection.keys.has(key) ? [...selection.keys] : [key]
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/rimlist-active', JSON.stringify(keys))
      setDrag({ keys, over: null, pos: null })
    },
    onDragOver: (e) => {
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const pos = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
      setDrag((d) => (d && d.over === key && d.pos === pos ? d : { ...(d || { keys: [] }), over: key, pos, external: !d }))
    },
    onDrop: (e) => {
      e.preventDefault()
      const ext = e.dataTransfer.getData('text/rimlist-inactive')
      const idx = order.indexOf(key) + (drag?.pos === 'after' ? 1 : 0)
      if (ext) {
        onDropFromInactive(JSON.parse(ext), idx)
      } else if (drag?.keys?.length) {
        const moving = new Set(drag.keys)
        const rest = order.filter((k) => !moving.has(k))
        const anchorIdx = rest.indexOf(key)
        const insertAt = moving.has(key) ? idx - drag.keys.filter((k) => order.indexOf(k) < idx).length : anchorIdx + (drag.pos === 'after' ? 1 : 0)
        const next = [...rest]
        next.splice(Math.max(0, Math.min(next.length, insertAt)), 0, ...drag.keys.sort((a, b) => order.indexOf(a) - order.indexOf(b)))
        onReorder(next)
      }
      setDrag(null)
    },
    onDragEnd: () => setDrag(null),
  })

  const dragClass = (key) => {
    if (!drag) return ''
    let c = ''
    if (drag.keys.includes(key)) c += ' rl-dragging'
    if (drag.over === key) c += drag.pos === 'before' ? ' rl-drop-before' : ' rl-drop-after'
    return c
  }

  return (
    <div className="rl-col">
      <div className="rl-col-head">
        <b>{t('active')}</b>
        <span className="rl-count">{order.length}</span>
      </div>
      <div className="rl-toolbar">
        <input className="rl-input" placeholder={t('searchActive')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <TagFilter allTags={allTags} tag={tag} setTag={setTag} tagIndex={tagIndex} />
      </div>
      <div
        className="rl-list"
        ref={listRef}
        tabIndex={0}
        onKeyDown={(e) => {
          // Alt+↑/↓ moves the selected mods one step (reorder from the keyboard)
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && selection.side === 'active' && selection.keys.size) {
            e.preventDefault()
            const sel = selection.keys
            const next = [...order]
            const up = e.key === 'ArrowUp'
            const idxs = next.map((k, i) => (sel.has(k) ? i : -1)).filter((i) => i >= 0)
            if (up ? idxs[0] === 0 : idxs[idxs.length - 1] === next.length - 1) return
            for (const i of up ? idxs : idxs.reverse()) {
              const j = up ? i - 1 : i + 1
              ;[next[i], next[j]] = [next[j], next[i]]
            }
            onReorder(next)
            scrollRowIntoView(listRef.current, selection.focus ?? selection.anchor)
            return
          }
          if (e.altKey) return
          navKey(e, visible, selection, 'active', setSelection)
        }}
        onDragOver={(e) => {
          if (e.target === listRef.current || e.target.classList.contains('rl-empty')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (e.target !== listRef.current && !e.target.classList.contains('rl-empty')) return
          const ext = e.dataTransfer.getData('text/rimlist-inactive')
          if (ext) onDropFromInactive(JSON.parse(ext), order.length)
          else if (drag?.keys?.length) {
            const moving = new Set(drag.keys)
            onReorder([...order.filter((k) => !moving.has(k)), ...drag.keys.sort((a, b) => order.indexOf(a) - order.indexOf(b))])
          }
          setDrag(null)
        }}
      >
        {visible.map((k) => {
          const m = catalog.get(k) || { key: k, packageId: k, name: k, kind: 'mod', source: 'missing', supportedVersions: [], author: '' }
          return (
            <ModRow
              key={k}
              mod={m}
              index={order.indexOf(k)}
              major={major}
              selected={selection.side === 'active' && selection.keys.has(k)}
              issues={issuesByMod.get(k)}
              onSelect={select}
              onPrimary={(key) => onDeactivate(selection.side === 'active' && selection.keys.has(key) ? [...selection.keys] : [key])}
              primaryIcon="left"
              dragProps={{ className: dragClass(k), handlers: handlersFor(k) }}
              extra={
                <>
                  <button className="rl-icon-btn" title={t('moveTop')} onClick={() => onMove(k, 0)}><Icon.top /></button>
                  <button className="rl-icon-btn" title={t('moveBottom')} onClick={() => onMove(k, order.length)}><Icon.bottom /></button>
                </>
              }
            />
          )
        })}
        {!visible.length && <div className="rl-empty">{filter ? '—' : t('dropHere')}</div>}
      </div>
    </div>
  )
}

export function InactiveColumn({ mods, activeSet, selection, setSelection, onActivate, onDeactivate, issuesByMod, major, filter, setFilter, sourceFilter, setSourceFilter, tagIndex, allTags = [], tag = '', setTag = () => {}, onSubscribe }) {
  const [over, setOver] = useState(false)
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return mods
      .filter((m) => !activeSet.has(m.key))
      .filter((m) => sourceFilter === 'all' || m.source === sourceFilter)
      .filter((m) => hasTag(tagIndex, m.key, tag))
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.key.includes(q) || (m.author || '').toLowerCase().includes(q) || m.publishedFileId === q)
  }, [mods, activeSet, filter, sourceFilter, tagIndex, tag])

  const select = (key, e) => {
    const keys = list.map((m) => m.key)
    if (e.shiftKey && selection.anchor && selection.side === 'inactive') {
      const a = keys.indexOf(selection.anchor)
      const b = keys.indexOf(key)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelection({ keys: new Set(keys.slice(lo, hi + 1)), anchor: selection.anchor, focus: key, side: 'inactive' })
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(selection.side === 'inactive' ? selection.keys : [])
      s.has(key) ? s.delete(key) : s.add(key)
      setSelection({ keys: s, anchor: key, side: 'inactive' })
    } else setSelection({ keys: new Set([key]), anchor: key, side: 'inactive' })
  }
  const handlersFor = (key) => ({
    onDragStart: (e) => {
      const keys = selection.side === 'inactive' && selection.keys.has(key) ? [...selection.keys] : [key]
      e.dataTransfer.effectAllowed = 'copyMove'
      e.dataTransfer.setData('text/rimlist-inactive', JSON.stringify(keys))
    },
  })
  const chips = [
    ['all', t('all')],
    ['workshop', t('workshop')],
    ['local', t('local')],
    ['official', t('official')],
  ]
  return (
    <div className="rl-col">
      <div className="rl-col-head">
        <b>{t('inactive')}</b>
        <span className="rl-count">{list.length}</span>
      </div>
      <div className="rl-toolbar">
        <input className="rl-input" placeholder={t('search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <TagFilter allTags={allTags} tag={tag} setTag={setTag} tagIndex={tagIndex} />
      </div>
      <div className="rl-toolbar" style={{ paddingTop: 0 }}>
        {chips.map(([v, label]) => (
          <button key={v} className="rl-chip" aria-pressed={sourceFilter === v} onClick={() => setSourceFilter(v)}>{label}</button>
        ))}
      </div>
      <div
        className={'rl-list' + (over ? ' rl-drop-zone' : '')}
        tabIndex={0}
        onKeyDown={(e) => !e.altKey && navKey(e, list.map((m) => m.key), selection, 'inactive', setSelection)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/rimlist-active')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (!over) setOver(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setOver(false)
        }}
        onDrop={(e) => {
          const data = e.dataTransfer.getData('text/rimlist-active')
          setOver(false)
          if (!data) return
          e.preventDefault()
          onDeactivate(JSON.parse(data))
        }}
      >
        {list.map((m) => (
          <ModRow
            key={m.key}
            mod={m}
            major={major}
            selected={selection.side === 'inactive' && selection.keys.has(m.key)}
            issues={issuesByMod.get(m.key)}
            onSelect={select}
            onPrimary={(key) => onActivate(selection.side === 'inactive' && selection.keys.has(key) ? [...selection.keys] : [key])}
            primaryIcon="right"
            dragProps={{ className: '', handlers: handlersFor(m.key) }}
            extra={
              m.source === 'workshop' && m.publishedFileId && onSubscribe ? (
                <button className="rl-icon-btn" title={t('subscribe')} onClick={() => onSubscribe(m.publishedFileId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8m-4-4h8"/></svg>
                </button>
              ) : null
            }
          />
        ))}
        {!list.length && <div className="rl-empty">—</div>}
      </div>
    </div>
  )
}
