// Token Monitor - zero-dependency Node server. Run: node server.js
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), https = require('https');
const ROOT = __dirname, CFG_FILE = path.join(ROOT, 'config.json'), DATA_DIR = path.join(ROOT, 'data');
const home = (p) => p.replace(/^~/, os.homedir());
let cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const priceRx = cfg.pricing.map(p => ({ ...p, rx: new RegExp(p.match, 'i') }));

// ---------- event store ----------
const intern = new Map(); const I = (v) => { let x = intern.get(v); if (x === undefined) { intern.set(v, v); x = v; } return x; };
const events = [];            // {t,a,m,i,o,cr,c5,c1,s,k}
const byKey = new Map();      // key -> index (Claude writes the same message several times)
let dirty = false;
function add(e) {
  e.m = I(e.m); e.s = I(e.s);
  const idx = byKey.get(e.k);
  if (idx === undefined) { byKey.set(e.k, events.length); events.push(e); }
  else if (e.o >= events[idx].o) events[idx] = e;
  dirty = true;
}
function cost(e) {
  const p = priceRx.find(x => x.rx.test(e.m)) || priceRx[priceRx.length - 1];
  return (e.i * p.in + e.o * p.out + e.cr * p.cr + e.c5 * p.cw5 + e.c1 * p.cw1) / 1e6;
}
const family = (m) => /opus/i.test(m) ? 'Opus' : /sonnet/i.test(m) ? 'Sonnet' : /haiku/i.test(m) ? 'Haiku' : /gemini/i.test(m) ? 'Gemini' : m;

// ---------- parsers (incremental, offset-based) ----------
const files = new Map(); // file -> {pos, model}
function parseClaude(line) {
  if (!line.includes('"usage"')) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const msg = o.message, u = msg && msg.usage;
  if (!u || o.type !== 'assistant' || !msg.model || msg.model === '<synthetic>') return;
  const cc = u.cache_creation;
  const c1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
  const c5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
  add({ t: Date.parse(o.timestamp), a: 'claude', m: msg.model, i: u.input_tokens || 0, o: u.output_tokens || 0,
        cr: u.cache_read_input_tokens || 0, c5, c1, s: (o.sessionId || '').slice(0, 8), k: 'c:' + (msg.id || o.uuid) + (o.requestId || '') });
}
function parseAgy(line, st, file) {
  if (!line.includes('input_tokens') && !line.includes('Model Selection')) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const mm = /Model Selection` from .*? to ([^\n]*?)\.(?:\s|$)/.exec(o.content || '');
  if (mm) st.model = mm[1].trim();
  if (o.input_tokens == null) return;
  const sid = path.basename(path.dirname(path.dirname(path.dirname(file))));
  const model = (o.model || st.model || 'gemini-unknown').toLowerCase().replace(/\s*\((\w+)\)/, '-$1').replace(/\s+/g, '-');
  add({ t: Date.parse(o.created_at), a: 'agy', m: model, i: o.input_tokens || 0, o: o.output_tokens || 0,
        cr: o.cache_read_tokens || 0, c5: 0, c1: 0, s: sid.slice(0, 8), k: 'g:' + sid + ':' + o.step_index });
}
function parseProxy(line) {
  let o; try { o = JSON.parse(line); } catch { return; }
  add({ ...o, a: 'proxy', k: 'p:' + o.t + ':' + o.s });
}
function parseCodex(line, st, file) {
  if (!line.includes('token_count') && !line.includes('turn_context')) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const p = o.payload || {};
  if (o.type === 'turn_context' && p.model) { st.model = p.model; return; }
  const u = p.type === 'token_count' && p.info && p.info.last_token_usage; if (!u) return;
  const cached = u.cached_input_tokens || 0;
  add({ t: Date.parse(o.timestamp), a: 'codex', m: st.model || 'codex', i: Math.max(0, (u.input_tokens || 0) - cached), o: u.output_tokens || 0, cr: cached, c5: 0, c1: 0,
        s: path.basename(file).slice(-14, -6), k: 'x:' + file + ':' + o.timestamp });
}
const PARSERS = { codex: parseCodex, claude: parseClaude, agy: parseAgy, proxy: parseProxy };
function ingest(file, agent) {
  let st = files.get(file); if (!st) { st = { pos: 0, model: '' }; files.set(file, st); }
  let size; try { size = fs.statSync(file).size; } catch { return; }
  if (size < st.pos) st.pos = 0;
  if (size === st.pos) return;
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - st.pos);
  fs.readSync(fd, buf, 0, buf.length, st.pos); fs.closeSync(fd);
  const nl = buf.lastIndexOf(10);
  if (nl < 0) return;                       // incomplete line, wait for more
  st.pos += nl + 1;
  const fn = PARSERS[agent];
  for (const l of buf.toString('utf8', 0, nl).split('\n')) if (l) fn(l, st, file);
}

// ---------- scan + watch ----------
const isAgy = (f) => path.basename(f) === 'transcript_full.jsonl' && !f.includes(path.sep + 'chunks' + path.sep);
const isClaude = (f) => f.endsWith('.jsonl');
function scan(dir, agent, match) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of ents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== 'chunks') scan(p, agent, match); }
    else if (match(p)) ingest(p, agent);
  }
}
function watch(dir, agent, match) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.watch(dir, { recursive: true }, (_, name) => { if (name && match(path.join(dir, name))) ingest(path.join(dir, name), agent); });
  } catch (e) { console.error('watch failed, polling', dir, e.message); setInterval(() => scan(dir, agent, match), 5000); }
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const proxyLog = path.join(DATA_DIR, 'proxy.jsonl');
// Auto-discovery: every agent whose data dir exists on THIS machine is picked up (re-checked every 30s).
const AGENTS = [
  { id: 'claude', name: 'Claude Code', color: '#d97757', dirs: [process.env.CLAUDE_CONFIG_DIR && path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), cfg.paths.claude, '~/.config/claude/projects'], match: isClaude },
  { id: 'agy', name: 'Antigravity', color: '#4f8cff', dirs: [cfg.paths.antigravity], match: isAgy },
  { id: 'codex', name: 'Codex', color: '#10a37f', dirs: ['~/.codex/sessions'], match: isClaude },
];
const META = { proxy: { name: 'Proxy', color: '#9b8cff' } }, watched = new Set();
function discover() {
  for (const ag of AGENTS) for (const d of ag.dirs) {
    if (!d) continue; const dir = home(d);
    if (watched.has(dir) || !fs.existsSync(dir)) continue;
    watched.add(dir); META[ag.id] = { name: ag.name, color: ag.color };
    scan(dir, ag.id, ag.match); watch(dir, ag.id, ag.match); console.log('detected', ag.name, dir);
  }
}
const t0 = Date.now();
discover(); setInterval(discover, 30000);
if (fs.existsSync(proxyLog)) ingest(proxyLog, 'proxy');
fs.watchFile(proxyLog, { interval: 1000 }, () => ingest(proxyLog, 'proxy'));
if (global.gc) global.gc();
console.log(`indexed ${events.length} requests from ${files.size} files in ${Date.now() - t0}ms`);

// ---------- snapshot ----------
const z = () => ({ n: 0, i: 0, o: 0, cr: 0, cw: 0, tok: 0, cost: 0 });
const tokOf = (e) => e.i + e.o + e.cr + e.c5 + e.c1;
const acc = (g, e, c) => { g.n++; g.i += e.i; g.o += e.o; g.cr += e.cr; g.cw += e.c5 + e.c1; g.tok += tokOf(e); g.cost += c; };
const pad = (n) => String(n).padStart(2, '0');
const dkey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const bump = (o, a, e, c) => { const x = o[a] || (o[a] = { tok: 0, cost: 0 }); x.tok += tokOf(e); x.cost += c; };
function snapshot() {
  const now = Date.now(), today = dkey(now), weekAgo = now - 6 * 864e5;
  const A = { all: z(), today: z(), week: z() }, ag = {}, models = {}, days = {}, hours = Array.from({ length: 24 }, () => ({})), active = new Set();
  for (const e of events) {
    const c = cost(e), dk = dkey(e.t), isToday = dk === today;
    acc(A.all, e, c); if (isToday) acc(A.today, e, c); if (e.t >= weekAgo) acc(A.week, e, c);
    const a = ag[e.a] || (ag[e.a] = { all: z(), today: z() }); acc(a.all, e, c); if (isToday) acc(a.today, e, c);
    const mk = e.a + '|' + e.m; const m = models[mk] || (models[mk] = { agent: e.a, model: e.m, family: family(e.m), ...z() }); acc(m, e, c);
    bump(days[dk] || (days[dk] = {}), e.a, e, c);
    if (isToday) bump(hours[new Date(e.t).getHours()], e.a, e, c);
    if (now - e.t < 5 * 60e3) active.add(e.a + ':' + e.s);
  }
  const keys = Object.keys(days).sort();
  const week = []; for (let k = 6; k >= 0; k--) { const key = dkey(now - k * 864e5); week.push({ label: key.slice(5), ...(days[key] || {}) }); }
  const month = []; for (let k = 29; k >= 0; k--) { const key = dkey(now - k * 864e5); month.push({ label: key.slice(5), ...(days[key] || {}) }); }
  const all = [];
  if (keys.length) { const s = new Date(keys[0] + 'T12:00:00').getTime(); for (let t = s; dkey(t) <= today; t += 864e5) { const key = dkey(t); all.push({ label: key.slice(2), ...(days[key] || {}) }); } }
  const top = []; for (const e of events) { if (top.length < 100 || e.t > top[99].t) { let j = top.length; if (j === 100) j--; top[j] = e; while (j > 0 && top[j - 1].t < top[j].t) { const x = top[j]; top[j] = top[j - 1]; top[j - 1] = x; j--; } } }
  const feed = top.map(e => ({ t: e.t, a: e.a, m: e.m, i: e.i, o: e.o, cr: e.cr, cw: e.c5 + e.c1, s: e.s, cost: cost(e) }));
  const rate = (g) => { const d = g.i + g.cr + g.cw; return d ? g.cr / d : 0; };
  return {
    asof: now, meta: META, count: events.length, thb: cfg.thbPerUsd, budget: cfg.budget, rss: process.memoryUsage().rss,
    totals: A, cache: { all: rate(A.all), today: rate(A.today) }, agents: ag,
    active: { n: active.size, list: [...active] }, models: Object.values(models).sort((x, y) => y.tok - x.tok),
    series: { today: hours.map((h, i) => ({ label: pad(i), ...h })), week, month, all }, feed,
  };
}

// ---------- HTTP: static + SSE + config ----------
const clients = new Set();
setInterval(() => {
  if (!dirty || !clients.size) return; dirty = false;
  const msg = 'data: ' + JSON.stringify(snapshot()) + '\n\n'; for (const r of clients) r.write(msg);
  if (global.gc) global.gc();
}, 400);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (url === '/api/snapshot') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(snapshot())); }
  if (url === '/api/config' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      try {
        const j = JSON.parse(b);
        if (j.budget) cfg.budget = { dailyTokens: +j.budget.dailyTokens || 0, dailyCostUsd: +j.budget.dailyCostUsd || 0 };
        if (j.thbPerUsd) cfg.thbPerUsd = +j.thbPerUsd;
        fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); dirty = true; res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    }); return;
  }
  const f = path.join(ROOT, 'public', url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[\\/])+/, ''));
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(data);
  });
});
server.listen(cfg.port, '127.0.0.1', () => console.log(`Token Monitor -> http://localhost:${cfg.port}`));

// ---------- optional proxy fallback ("proxyPort" in config.json, or --proxy=PORT) ----------
// Point an agent at http://localhost:<proxyPort> (e.g. ANTHROPIC_BASE_URL). Requests are forwarded
// untouched; usage is read from the response (JSON or SSE) and appended to data/proxy.jsonl.
const pArg = process.argv.find(a => a.startsWith('--proxy='));
const proxyPort = pArg ? +pArg.slice(8) : cfg.proxyPort;
if (proxyPort) {
  const up = new URL(cfg.proxyUpstream), lib = up.protocol === 'https:' ? https : http;
  http.createServer((creq, cres) => {
    const chunks = []; creq.on('data', c => chunks.push(c)); creq.on('end', () => {
      const body = Buffer.concat(chunks); let model = ''; try { model = JSON.parse(body).model || ''; } catch {}
      const preq = lib.request({ hostname: up.hostname, port: up.port || undefined, path: creq.url, method: creq.method, headers: { ...creq.headers, host: up.host } }, (pres) => {
        cres.writeHead(pres.statusCode, pres.headers); const out = [];
        pres.on('data', c => { out.push(c); cres.write(c); });
        pres.on('end', () => {
          cres.end(); const txt = Buffer.concat(out).toString('utf8');
          const grab = (k) => { let v = 0; for (const m of txt.matchAll(new RegExp('"' + k + '":(\\d+)', 'g'))) v = Math.max(v, +m[1]); return v; };
          const u = { i: grab('input_tokens'), o: grab('output_tokens'), cr: grab('cache_read_input_tokens'), c5: grab('cache_creation_input_tokens'), c1: 0 };
          const mm = /"model":"([^"]+)"/.exec(txt); if (mm) model = mm[1];
          if (u.i || u.o || u.cr || u.c5) fs.appendFile(proxyLog, JSON.stringify({ t: Date.now(), m: model || 'unknown', ...u, s: 'proxy' }) + '\n', () => {});
        });
      });
      preq.on('error', e => { cres.writeHead(502); cres.end(String(e)); }); preq.end(body);
    });
  }).listen(proxyPort, '127.0.0.1', () => console.log(`Proxy fallback :${proxyPort} -> ${cfg.proxyUpstream}`));
}
