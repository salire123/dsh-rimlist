// Session gate: the rimlist_* tools stay hidden from an agent until the user types "/rimlist"
// in that session. Hiding uses agent.ctx.tools.restrict({ deny }), which removes the schemas
// from that agent only; once a "/rimlist" user message is seen, the restriction is lifted for
// the rest of the session (also after resume, because the session history is scanned).

// Same token shape DSH uses for /skill gestures: whitespace-bounded, so paths like /a/rimlist don't match.
const GESTURE = /(^|\s)\/rimlist(?=\s|$)/

function hasGesture(message) {
  if (!message || message.source?.kind !== 'user' || !Array.isArray(message.content)) return false
  return message.content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && GESTURE.test(b.text))
}

/** Scan the durable session history for an earlier "/rimlist" user message. */
function historyHasGesture(agent) {
  const session = agent?.session
  if (!session || typeof session.eventAt !== 'function' || typeof session.seq !== 'number') return false
  for (let i = session.seq - 1; i >= 0; i--) {
    let event
    try {
      event = session.eventAt(i)
    } catch {
      return false
    }
    if (event?.type === 'user/message' && hasGesture(event.data)) return true
  }
  return false
}

/**
 * @param ctx plugin context
 * @param toolNames names of the tools to gate
 * @param log logger
 * @returns disposer that lifts every restriction this gate placed
 */
export function installToolGate(ctx, toolNames, log) {
  /** @type {WeakMap<object, { active: boolean, lift: (() => void) | null }>} */
  const states = new WeakMap()
  const lifts = new Set()

  const hide = (agent, state) => {
    if (state.lift) return
    const tools = agent?.ctx?.tools
    if (!tools || typeof tools.restrict !== 'function') return
    try {
      const d = tools.restrict({ deny: toolNames })
      state.lift = typeof d === 'function' ? d : null
      if (state.lift) lifts.add(state.lift)
    } catch (err) {
      log('tool gate: restrict failed: ' + ((err && err.message) || err))
    }
  }
  const show = (state) => {
    if (!state.lift) return
    const d = state.lift
    state.lift = null
    lifts.delete(d)
    try {
      d()
    } catch {}
  }

  const off = ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload?.agent
      if (agent && typeof agent === 'object') {
        let state = states.get(agent)
        if (!state) {
          state = { active: historyHasGesture(agent), lift: null }
          states.set(agent, state)
        }
        if (!state.active && Array.isArray(payload.messages) && payload.messages.some(hasGesture)) state.active = true
        if (state.active) show(state)
        else hide(agent, state)
      }
    } catch (err) {
      log('tool gate error: ' + ((err && err.message) || err))
    }
    return next()
  })

  return () => {
    if (typeof off === 'function') off()
    for (const d of lifts) {
      try {
        d()
      } catch {}
    }
    lifts.clear()
  }
}
