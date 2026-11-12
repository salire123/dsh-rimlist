// Dev harness: run the host plugin against a fake ctx with a plain http server.
// Usage: node scripts/dev-server.mjs   (POST http://127.0.0.1:4777/api/rimlist; data in ./.tmp-home/rimlist)
import http from 'node:http'
import path from 'node:path'

process.env.DSH_HOME = process.env.RIMLIST_DEV_HOME || path.resolve('.tmp-home')
const { apply } = await import('../index.js')
const tools = new Map()
let handler = null
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  get: (name) => {
    if (name === 'webServer') return { register: ({ handler: h }) => ((handler = h), () => (handler = null)) }
    if (name === 'timer') return { interval: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id) } }
    return undefined
  },
}
apply(ctx)
const port = Number(process.env.PORT || 4777)
http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/rimlist')) return handler(req, res)
    // Serve a minimal dev page that loads the client bundle with a fake module loader.
    if (req.url === '/' || req.url.startsWith('/dev')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(DEV_HTML)
    }
    if (req.url === '/client.js') {
      import('node:fs').then((fs) => {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        fs.createReadStream(path.resolve('lib/client.js')).pipe(res)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  .listen(port, '127.0.0.1', () => console.log(`dev server http://127.0.0.1:${port}/  tools: ${[...tools.keys()].join(', ')}`))

const DEV_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>rimlist dev</title>
<style>html,body{margin:0;height:100%;background:#111;color:#eee}#root{height:100vh}
:root{--dsw-alias-label-primary:#e8e8e8;--dsw-alias-label-secondary:#9a9a9a;--dsw-alias-label-tertiary:#6a6a6a;--dsw-alias-bg-layer-1:#141414;--dsw-alias-bg-layer-2:#1c1c1c;--dsw-alias-border-l1:#2a2a2a;--dsw-alias-border-l2:#333;--dsw-alias-state-business-primary:#4d7cff;--dsw-alias-state-error-primary:#ff5c5c;--dsw-alias-state-warn-primary:#ffb547;--dsw-alias-state-success-primary:#4ccf7a;--dsw-alias-interactive-bg-hover:#262626;--dsw-font-s-14:14px/1.5 system-ui}</style>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>
</head><body><div id="root"></div>
<script>
window.__ModuleLoader__ = { load({ id, factory }) {
  const mk = (type, props, key) => { const { children, ...rest } = props || {}; if (key !== undefined) rest.key = key; return Array.isArray(children) ? React.createElement(type, rest, ...children) : children === undefined ? React.createElement(type, rest) : React.createElement(type, rest, children); };
  const jsx = mk;
  const req = (n) => ({ 'react': React, 'react-dom': ReactDOM, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: React.Fragment } })[n];
  const plugin = factory(req);
  const slots = { inject: (n, fn) => fn(), register: (spec, render) => { window.__render = render; } };
  const tabs = { register: (spec) => { window.__tabSpec = spec; return () => {}; } };
  const owner = { get: (n) => n === 'sidebarRightTabs' ? tabs : n === 'slots' ? slots : undefined, effect: (fn) => fn(), slots };
  plugin.apply({ get: (n) => n === 'slots' ? slots : undefined, inject: (deps, fn) => fn(owner) });
  window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
  const __ce = console.error; console.error = (...a) => { window.__errs.push(a.map(String).join(' ').slice(0, 300)); __ce(...a); };
  ReactDOM.createRoot(document.getElementById('root')).render(window.__render({ sessionId: 'dev' }));
  // RIMLIST_TEST_CLICKS: ?clicks=rules,databases,... drives the UI for headless verification
  const q = new URLSearchParams(location.search).get('clicks');
  if (q) setTimeout(() => { const log = []; const steps = q.split(','); let i = 0;
    const next = () => { if (i >= steps.length) { const o = document.createElement('pre'); o.id = 'probe'; o.textContent = JSON.stringify({ log, errs: window.__errs }); document.body.appendChild(o); return; }
      const [kind, arg] = steps[i++].split(':');
      if (kind === 'measure') { const el = document.querySelector(arg); log.push({ measure: arg, found: !!el, self: el && [el.clientHeight, el.scrollHeight, getComputedStyle(el).overflow], kids: el ? [...el.children].map((c) => [c.className || c.tagName, Math.round(c.getBoundingClientRect().height), getComputedStyle(c).display]) : [] }); return next(); }
      const btn = kind === 'row' ? [...document.querySelectorAll('.rl-row')].find((r) => r.textContent.includes(arg)) : kind === 'click' ? document.querySelector(arg) : [...document.querySelectorAll('button')].find((b) => kind === 'tab' ? b.getAttribute('title') === arg : kind === 'text' ? b.textContent.trim().startsWith(arg) : false);
      if (btn) btn.click();
      setTimeout(() => { log.push({ step: kind + ':' + arg, clicked: !!btn, body: document.querySelector('.rl-body')?.innerText.slice(0, 0) + (document.querySelector('.rl-root')?.innerText.length || 0), blank: !document.querySelector('.rl-root') }); next(); }, 400); };
    next(); }, 1500);
}};
</script>
<script src="/client.js"></script></body></html>`
