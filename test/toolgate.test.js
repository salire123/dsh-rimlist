import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installToolGate } from '../src/host/toolgate.js'

function harness() {
  let handler = null
  const ctx = { on: (name, fn) => { assert.equal(name, 'agent/pre-step'); handler = fn; return () => { handler = null } } }
  const makeAgent = (history = []) => {
    const agent = {
      denied: null,
      restricts: 0,
      session: { seq: history.length, eventAt: (i) => history[i] },
      ctx: { tools: { restrict: (f) => { agent.restricts++; agent.denied = f.deny; return () => { agent.denied = null } } } },
    }
    return agent
  }
  const step = (agent, texts = []) => handler({ agent, messages: texts.map((t) => ({ source: { kind: 'user' }, content: [{ type: 'text', text: t }] })) }, async () => 'ok')
  return { ctx, makeAgent, step, get handler() { return handler } }
}
const NAMES = ['rimlist_status', 'rimlist_sort']

test('hidden until /rimlist, then shown for the rest of the session', async () => {
  const h = harness()
  const dispose = installToolGate(h.ctx, NAMES, () => {})
  const a = h.makeAgent()
  assert.equal(await h.step(a, ['hello']), 'ok')
  assert.deepEqual(a.denied, NAMES)
  await h.step(a, ['what about /a/rimlist path'])
  assert.deepEqual(a.denied, NAMES, 'paths do not count')
  await h.step(a, ['/rimlist 看看我的 mod'])
  assert.equal(a.denied, null)
  await h.step(a, ['next turn without it'])
  assert.equal(a.denied, null, 'stays on')
  assert.equal(a.restricts, 1)
  dispose()
  assert.equal(h.handler, null)
})

test('resumed session with an earlier /rimlist starts unlocked', async () => {
  const h = harness()
  installToolGate(h.ctx, NAMES, () => {})
  const a = h.makeAgent([{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi /rimlist' }] } }])
  await h.step(a, ['continue'])
  assert.equal(a.restricts, 0)
})

test('model or tool text cannot unlock', async () => {
  const h = harness()
  installToolGate(h.ctx, NAMES, () => {})
  const a = h.makeAgent()
  await h.handler({ agent: a, messages: [{ source: { kind: 'tool' }, content: [{ type: 'text', text: '/rimlist' }] }] }, async () => 'ok')
  assert.deepEqual(a.denied, NAMES)
})

test('dispose lifts restrictions', async () => {
  const h = harness()
  const dispose = installToolGate(h.ctx, NAMES, () => {})
  const a = h.makeAgent()
  await h.step(a, ['hi'])
  dispose()
  assert.equal(a.denied, null)
})
