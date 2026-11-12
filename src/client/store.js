import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { t } from './i18n.js'

/** Central store for one Mods tab instance. */
export function useRimlist() {
  const [snap, setSnap] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  // Local (unsaved) active order; null means "same as snapshot.active".
  const [draft, setDraft] = useState(null)
  const [diag, setDiag] = useState(null)
  const toastTimer = useRef(null)

  const say = useCallback((msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const s = await api('snapshot')
      setSnap(s)
      setDiag(s.diagnostics)
      setError(null)
      return s
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const catalog = useMemo(() => new Map((snap?.mods || []).map((m) => [m.key, m])), [snap])
  const active = draft || snap?.active || []
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(snap?.active || [])

  // Re-diagnose the draft on the server whenever it changes (debounced).
  useEffect(() => {
    if (!draft) return
    const id = setTimeout(() => api('diagnose', { ids: draft }).then(setDiag).catch(() => {}), 200)
    return () => clearTimeout(id)
  }, [draft])

  const run = useCallback(
    async (fn, okMsg) => {
      setBusy(true)
      try {
        const r = await fn()
        if (okMsg) say(okMsg)
        return r
      } catch (e) {
        say('✖ ' + e.message)
        throw e
      } finally {
        setBusy(false)
      }
    },
    [say],
  )

  const actions = {
    refresh,
    setOrder: (ids) => setDraft(ids),
    activate: (keys, index) => {
      const cur = [...active]
      const add = keys.filter((k) => !cur.includes(k))
      if (typeof index === 'number') cur.splice(index, 0, ...add)
      else cur.push(...add)
      setDraft(cur)
    },
    deactivate: (keys) => {
      const rm = new Set(keys)
      setDraft(active.filter((k) => !rm.has(k)))
    },
    /** Swap oldKey for newKey in the same load-order slot (newKey is pulled from wherever it was). */
    replace: (oldKey, newKey) => {
      const cur = active.filter((k) => k !== newKey)
      const i = cur.indexOf(oldKey)
      if (i < 0) cur.push(newKey)
      else cur.splice(i, 1, newKey)
      setDraft(cur)
    },
    move: (key, to) => {
      const cur = [...active]
      const i = cur.indexOf(key)
      if (i < 0) return
      cur.splice(i, 1)
      cur.splice(Math.max(0, Math.min(cur.length, to)), 0, key)
      setDraft(cur)
    },
    discard: () => setDraft(null),
    /** After a server-side write (apply list, restore backup) the saved config changed: drop the draft and refresh. */
    setOrderFromServer: async () => {
      setDraft(null)
      await refresh()
    },
    save: () =>
      run(async () => {
        await api('setActive', { ids: active })
        setDraft(null)
        await refresh()
      }, t('saved')),
    sort: () =>
      run(async () => {
        const r = await api('sortIds', { ids: active })
        setDraft(r.order)
        const parts = [`${t('moved')} ${r.moved}`]
        if (r.broken.length) parts.push(`${t('cycles')} ${r.broken.length}`)
        parts.push(`${r.before.error}E/${r.before.warning}W → ${r.after.error}E/${r.after.warning}W`)
        say(parts.join(' · '))
        return r
      }),
    rescan: () => run(async () => { await api('rescan'); await refresh() }, t('rescan') + ' ✓'),
    refreshRules: () => run(async () => { await api('refreshRules', { force: true }); await refresh() }, t('refreshRules') + ' ✓'),
    api: (method, args, okMsg) => run(() => api(method, args), okMsg),
    say,
  }

  return { snap, error, busy, toast, active, dirty, diag, catalog, actions }
}
