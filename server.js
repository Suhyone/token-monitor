// Token Monitor - zero-dependency Node server. Run: node server.js
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), https = require('https');
const ROOT = __dirname, CFG_FILE = path.join(ROOT, 'config.json'), DATA_DIR = path.join(ROOT, 'data');
const home = (p) => (p || '').replace(/^~/, os.homedir());

const DEFAULT_CFG = {
  port: 8787,
  proxyPort: 0,
  proxyUpstream: 'https://api.anthropic.com',
  thbPerUsd: 34,
  retentionDays: 7,
  paths: {},
  pricing: [
    { match: 'opus', in: 5, out: 25, cr: 0.5, cw5: 6.25, cw1: 10 },
    { match: 'sonnet', in: 3, out: 15, cr: 0.3, cw5: 3.75, cw1: 6 },
    { match: 'haiku', in: 1, out: 5, cr: 0.1, cw5: 1.25, cw1: 2 },
    { match: 'gemini.*flash', in: 0.3, out: 2.5, cr: 0.03, cw5: 0.3, cw1: 0.3 },
    { match: 'gemini', in: 2, out: 12, cr: 0.2, cw5: 2, cw1: 2 },
    { match: 'gpt-5|codex', in: 1.25, out: 10, cr: 0.125, cw5: 1.25, cw1: 1.25 },
    { match: 'gpt-4o-mini|o4-mini|o3-mini|o1-mini', in: 0.15, out: 0.6, cr: 0.075, cw5: 0.15, cw1: 0.15 },
    { match: 'gpt-4|o1|o3|o4', in: 2.5, out: 10, cr: 1.25, cw5: 2.5, cw1: 2.5 },
    { match: 'deepseek', in: 0.27, out: 1.1, cr: 0.07, cw5: 0.27, cw1: 0.27 },
    { match: 'qwen', in: 0.4, out: 1.2, cr: 0.1, cw5: 0.4, cw1: 0.4 },
    { match: 'grok', in: 3, out: 15, cr: 0.75, cw5: 3, cw1: 3 },
    { match: '.*', in: 3, out: 15, cr: 0.3, cw5: 3.75, cw1: 6 }
  ]
};
let userCfg = {};
try { userCfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch {}
const cfg = { ...DEFAULT_CFG, ...userCfg, paths: { ...DEFAULT_CFG.paths, ...(userCfg.paths || {}) } };
if (!Array.isArray(cfg.pricing) || !cfg.pricing.length) cfg.pricing = DEFAULT_CFG.pricing;
const priceRx = cfg.pricing.map(p => ({ ...p, rx: new RegExp(p.match, 'i') }));
const RETENTION_MS = Math.max(1, +cfg.retentionDays || 7) * 864e5;

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const dkey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const tokOf = (e) => e.i + e.o + e.cr + e.c5 + e.c1;
function cost(e) {
  const p = priceRx.find(x => x.rx.test(e.m)) || priceRx[priceRx.length - 1];
  return (e.i * p.in + e.o * p.out + e.cr * p.cr + e.c5 * p.cw5 + e.c1 * p.cw1) / 1e6;
}
function family(m) {
  if (/opus/i.test(m)) return 'Opus';
  if (/sonnet/i.test(m)) return 'Sonnet';
  if (/haiku/i.test(m)) return 'Haiku';
  if (/claude/i.test(m)) return 'Claude';
  if (/gemini/i.test(m)) return 'Gemini';
  if (/codex/i.test(m)) return 'Codex';
  if (/gpt-?5/i.test(m)) return 'GPT-5';
  if (/gpt-?4/i.test(m)) return 'GPT-4';
  if (/^o[134]/i.test(m)) return 'OpenAI-o';
  if (/deepseek/i.test(m)) return 'DeepSeek';
  if (/qwen/i.test(m)) return 'Qwen';
  if (/grok/i.test(m)) return 'Grok';
  if (/llama/i.test(m)) return 'Llama';
  if (/mistral/i.test(m)) return 'Mistral';
  return m;
}
function cleanPrompt(txt) {
  if (!txt || typeof txt !== 'string') return '';
  return txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
}

// ---------- event & turn store (7-day detailed + daily archive) ----------
const intern = new Map();
const I = (v) => { let x = intern.get(v); if (x === undefined) { intern.set(v, v); x = v; } return x; };
let events = [];              // {t,a,m,i,o,cr,c5,c1,s,k,turnId}
let byKey = new Map();        // key -> index in events
let turns = [];               // {id,a,s,m,prompt,t0,t1,status,steps,interrupts,i,o,cr,cw,tok,cost}
const turnById = new Map();   // id -> turn
const activeTurns = new Map();// agent:session -> turn
const dailyArchive = {};      // dayKey -> { agent -> {n,i,o,cr,cw,tok,cost,q} }
const archivedKeys = new Set();
let turnSeq = 0, dirty = false;

function addArchive(dk, a, e, c, qDelta = 0) {
  const day = dailyArchive[dk] || (dailyArchive[dk] = {});
  const g = day[a] || (day[a] = { n: 0, i: 0, o: 0, cr: 0, cw: 0, tok: 0, cost: 0, q: 0 });
  if (e) {
    g.n++; g.i += e.i; g.o += e.o; g.cr += e.cr; g.cw += e.c5 + e.c1;
    g.tok += tokOf(e); g.cost += c;
  }
  if (qDelta) g.q += qDelta;
}

function startOrInterruptTurn(a, s, t, promptText) {
  if (!t || t < Date.now() - RETENTION_MS) return;
  s = I(s || 'default');
  const key = a + ':' + s;
  const cur = activeTurns.get(key);
  const txt = cleanPrompt(promptText);
  if (cur && cur.status === 'running' && (t - cur.t1) < 30 * 60e3) {
    // Interrupting / follow-up question while previous question hasn't finished outputting
    cur.interrupts++;
    cur.t1 = Math.max(cur.t1, t);
    if (!cur.prompt && txt) cur.prompt = txt;
    dirty = true;
    return cur;
  }
  const turn = {
    id: key + ':' + t + ':' + (++turnSeq),
    a, s, m: '', prompt: txt,
    t0: t, t1: t, status: 'running',
    steps: 0, interrupts: 0,
    i: 0, o: 0, cr: 0, cw: 0, tok: 0, cost: 0
  };
  turns.push(turn);
  turnById.set(turn.id, turn);
  activeTurns.set(key, turn);
  dirty = true;
  return turn;
}

function finishTurn(a, s, t) {
  const key = a + ':' + (s || 'default');
  const cur = activeTurns.get(key);
  if (cur && cur.status === 'running') {
    cur.status = 'done';
    if (t) cur.t1 = Math.max(cur.t1, t);
    dirty = true;
  }
}

function attachEventToTurn(e, prev) {
  const cNew = cost(e), tokNew = tokOf(e), cwNew = e.c5 + e.c1;
  if (prev && prev.turnId) {
    const turn = turnById.get(prev.turnId);
    if (turn) {
      const cOld = cost(prev), tokOld = tokOf(prev), cwOld = prev.c5 + prev.c1;
      turn.i += e.i - prev.i;
      turn.o += e.o - prev.o;
      turn.cr += e.cr - prev.cr;
      turn.cw += cwNew - cwOld;
      turn.tok += tokNew - tokOld;
      turn.cost += cNew - cOld;
      turn.m = e.m || turn.m;
      turn.t1 = Math.max(turn.t1, e.t);
      e.turnId = turn.id;
      return;
    }
  }
  const key = e.a + ':' + e.s;
  let cur = activeTurns.get(key);
  if (!cur || (cur.status === 'done' && (e.t - cur.t1) > 3000) || (e.t - cur.t1) > 10 * 60e3) {
    cur = {
      id: key + ':' + e.t + ':' + (++turnSeq),
      a: e.a, s: e.s, m: e.m, prompt: '',
      t0: e.t, t1: e.t, status: 'running',
      steps: 0, interrupts: 0,
      i: 0, o: 0, cr: 0, cw: 0, tok: 0, cost: 0
    };
    turns.push(cur);
    turnById.set(cur.id, cur);
    activeTurns.set(key, cur);
  }
  cur.steps++;
  cur.i += e.i; cur.o += e.o; cur.cr += e.cr; cur.cw += cwNew;
  cur.tok += tokNew; cur.cost += cNew;
  cur.m = e.m || cur.m;
  cur.t1 = Math.max(cur.t1, e.t);
  e.turnId = cur.id;
}

function add(e) {
  if (!e.t || isNaN(e.t)) return;
  e.m = I(e.m || 'unknown'); e.s = I(e.s || 'default');
  const cutoff = Date.now() - RETENTION_MS;
  if (e.t < cutoff) {
    if (!archivedKeys.has(e.k)) {
      archivedKeys.add(e.k);
      addArchive(dkey(e.t), e.a, e, cost(e));
      dirty = true;
    }
    return;
  }
  const idx = byKey.get(e.k);
  if (idx === undefined) {
    attachEventToTurn(e, null);
    byKey.set(e.k, events.length);
    events.push(e);
    dirty = true;
  } else if (e.o >= events[idx].o) {
    attachEventToTurn(e, events[idx]);
    events[idx] = e;
    dirty = true;
  }
}

function pruneOldEvents() {
  const cutoff = Date.now() - RETENTION_MS;
  let pruned = 0;
  const kept = [];
  const newMap = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.t < cutoff) {
      addArchive(dkey(e.t), e.a, e, cost(e));
      archivedKeys.add(e.k);
      pruned++;
    } else {
      newMap.set(e.k, kept.length);
      kept.push(e);
    }
  }
  if (pruned > 0) {
    events = kept;
    byKey = newMap;
    dirty = true;
  }
  const keptTurns = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.t1 < cutoff) {
      addArchive(dkey(t.t0), t.a, null, 0, 1);
      turnById.delete(t.id);
      const key = t.a + ':' + t.s;
      if (activeTurns.get(key) === t) activeTurns.delete(key);
    } else {
      keptTurns.push(t);
    }
  }
  if (keptTurns.length !== turns.length) {
    turns = keptTurns;
    dirty = true;
  }
  if (pruned > 0 && global.gc) global.gc();
}
setInterval(pruneOldEvents, 10 * 60e3);

// ---------- parsers ----------
const files = new Map(); // file -> {pos, mtime, size, model}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (typeof c === 'string') parts.push(c);
      else if (c && c.type === 'text' && c.text) parts.push(c.text);
    }
    return parts.join(' ');
  }
  return '';
}

function parseClaude(line) {
  if (!line.includes('"type"')) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const t = Date.parse(o.timestamp), s = (o.sessionId || '').slice(0, 8);
  const msg = o.message;
  if (o.type === 'user' && msg) {
    const c = msg.content;
    const isToolResult = Array.isArray(c) && c.some(x => x && x.type === 'tool_result');
    if (!isToolResult) {
      const txt = extractText(c);
      if (txt && !txt.startsWith('<command-')) startOrInterruptTurn('claude', s, t, txt);
    }
    return;
  }
  const u = msg && msg.usage;
  if (o.type === 'assistant' && msg) {
    if (u && msg.model && msg.model !== '<synthetic>') {
      const cc = u.cache_creation;
      const c1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
      const c5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
      add({
        t, a: 'claude', m: msg.model, i: u.input_tokens || 0, o: u.output_tokens || 0,
        cr: u.cache_read_input_tokens || 0, c5, c1, s,
        k: 'c:' + (msg.id || o.uuid) + (o.requestId || '')
      });
    }
    const hasToolUse = Array.isArray(msg.content) && msg.content.some(x => x && x.type === 'tool_use');
    if (msg.stop_reason === 'end_turn' || (!hasToolUse && msg.stop_reason && msg.stop_reason !== 'tool_use')) {
      finishTurn('claude', s, t);
    }
  }
}

function parseAgy(line, st, file) {
  if (!line.includes('input_tokens') && !line.includes('Model Selection') && !line.includes('"user"') && !line.includes('"assistant"')) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const sid = path.basename(path.dirname(path.dirname(path.dirname(file)))).slice(0, 8);
  const t = Date.parse(o.created_at || o.timestamp);
  const mm = /Model Selection` from .*? to ([^\n]*?)\.(?:\s|$)/.exec(o.content || '');
  if (mm) st.model = mm[1].trim();
  if ((o.role === 'user' || o.type === 'user' || o.author === 'user') && o.content) {
    startOrInterruptTurn('agy', sid, t, extractText(o.content));
  }
  if (o.input_tokens != null) {
    const model = (o.model || st.model || 'gemini-unknown').toLowerCase().replace(/\s*\((\w+)\)/, '-$1').replace(/\s+/g, '-');
    add({
      t, a: 'agy', m: model, i: o.input_tokens || 0, o: o.output_tokens || 0,
      cr: o.cache_read_tokens || 0, c5: 0, c1: 0, s: sid,
      k: 'g:' + sid + ':' + o.step_index
    });
  }
  if ((o.role === 'assistant' || o.type === 'assistant' || o.type === 'model_response') && !o.tool_calls?.length && o.is_final) {
    finishTurn('agy', sid, t);
  }
}

function parseCodex(line, st, file) {
  if (!line.includes('token_count') && !line.includes('turn_context') && !line.includes('user_message') && !line.includes('agent_message')) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const p = o.payload || {}, t = Date.parse(o.timestamp), s = path.basename(file).slice(-14, -6);
  if (o.type === 'turn_context' && p.model) { st.model = p.model; return; }
  if (o.type === 'event_msg' && p.type === 'user_message') {
    startOrInterruptTurn('codex', s, t, p.message || p.text || '');
    return;
  }
  if (o.type === 'event_msg' && p.type === 'agent_message') {
    finishTurn('codex', s, t);
    return;
  }
  const u = p.type === 'token_count' && p.info && p.info.last_token_usage;
  if (!u) return;
  const cached = u.cached_input_tokens || 0;
  add({
    t, a: 'codex', m: st.model || 'codex',
    i: Math.max(0, (u.input_tokens || 0) - cached), o: u.output_tokens || 0,
    cr: cached, c5: 0, c1: 0, s,
    k: 'x:' + file + ':' + o.timestamp
  });
}

function parseProxy(line) {
  let o; try { o = JSON.parse(line); } catch { return; }
  add({ ...o, a: o.a || 'proxy', k: 'p:' + o.t + ':' + (o.s || 'proxy') + ':' + (o.m || '') });
}

function parseGeminiFile(file) {
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const msgs = Array.isArray(j.messages) ? j.messages : [];
  const sid = (j.sessionId || path.basename(file, '.json')).slice(0, 8);
  for (let idx = 0; idx < msgs.length; idx++) {
    const m = msgs[idx], t = Date.parse(m.timestamp || j.startTime);
    if (m.type === 'user') {
      startOrInterruptTurn('gemini', sid, t, extractText(m.content));
    } else if (m.type === 'gemini') {
      if (m.tokens) {
        const tk = m.tokens;
        add({
          t, a: 'gemini', m: m.model || 'gemini',
          i: tk.input || 0, o: (tk.output || 0) + (tk.thoughts || 0),
          cr: tk.cached || 0, c5: 0, c1: 0, s: sid,
          k: 'gm:' + sid + ':' + (m.id || idx)
        });
      }
      if ((!m.toolCalls || !m.toolCalls.length) && m.content) finishTurn('gemini', sid, t);
    }
  }
}

function parseOpencodeFile(file) {
  let m; try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!m || !m.id) return;
  const sid = (m.sessionID || 'oc').slice(0, 8);
  const t = (m.time && (m.time.created || m.time.completed)) || Date.now();
  if (m.role === 'user') {
    startOrInterruptTurn('opencode', sid, t, m.summary?.title || '');
  } else if (m.role === 'assistant' && m.tokens) {
    const tk = m.tokens, c = tk.cache || {};
    add({
      t, a: 'opencode', m: m.modelID || m.providerID || 'opencode',
      i: tk.input || 0, o: (tk.output || 0) + (tk.reasoning || 0),
      cr: c.read || 0, c5: c.write || 0, c1: 0, s: sid,
      k: 'oc:' + m.id
    });
    if (m.time && m.time.completed && m.finish !== 'tool-calls') finishTurn('opencode', sid, m.time.completed);
  }
}

function parseClineFile(file, agentId) {
  let arr; try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!Array.isArray(arr)) return;
  const sid = path.basename(path.dirname(file)).slice(0, 8);
  for (let idx = 0; idx < arr.length; idx++) {
    const m = arr[idx], t = m.ts || Date.now();
    if (m.say === 'user_feedback' || (m.type === 'say' && m.say === 'task')) {
      startOrInterruptTurn(agentId, sid, t, m.text || '');
    } else if (m.say === 'api_req_started' && m.text) {
      let info; try { info = JSON.parse(m.text); } catch { continue; }
      if (info.tokensIn != null || info.tokensOut != null) {
        add({
          t, a: agentId, m: info.model || agentId,
          i: info.tokensIn || 0, o: info.tokensOut || 0,
          cr: info.cacheReads || 0, c5: info.cacheWrites || 0, c1: 0, s: sid,
          k: agentId + ':' + sid + ':' + t + ':' + idx
        });
      }
    } else if (m.say === 'completion_result') {
      finishTurn(agentId, sid, t);
    }
  }
}

const PARSERS = { codex: parseCodex, claude: parseClaude, agy: parseAgy, proxy: parseProxy };
const JSON_PARSERS = { gemini: parseGeminiFile, opencode: parseOpencodeFile, cline: (f) => parseClineFile(f, 'cline'), roo: (f) => parseClineFile(f, 'roo') };

function ingest(file, agent) {
  let st = files.get(file); if (!st) { st = { pos: 0, mtime: 0, size: 0, model: '' }; files.set(file, st); }
  let stat; try { stat = fs.statSync(file); } catch { return; }
  if (JSON_PARSERS[agent]) {
    if (stat.mtimeMs === st.mtime && stat.size === st.size) return;
    st.mtime = stat.mtimeMs; st.size = stat.size;
    JSON_PARSERS[agent](file);
    return;
  }
  const size = stat.size;
  if (size < st.pos) st.pos = 0;
  if (size === st.pos) return;
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - st.pos);
  fs.readSync(fd, buf, 0, buf.length, st.pos); fs.closeSync(fd);
  const nl = buf.lastIndexOf(10);
  if (nl < 0) return;
  st.pos += nl + 1;
  const fn = PARSERS[agent];
  if (!fn) return;
  for (const l of buf.toString('utf8', 0, nl).split('\n')) if (l) fn(l, st, file);
}

// ---------- scan + watch (zero-config multi-provider auto-discovery) ----------
const isAgy = (f) => path.basename(f) === 'transcript_full.jsonl' && !f.includes(path.sep + 'chunks' + path.sep);
const isJsonl = (f) => f.endsWith('.jsonl');
const isGeminiChat = (f) => f.endsWith('.json') && f.includes(path.sep + 'chats' + path.sep);
const isJson = (f) => f.endsWith('.json');
const isUiMsg = (f) => path.basename(f) === 'ui_messages.json';

function scan(dir, agent, match) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of ents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== 'chunks' && d.name !== 'node_modules') scan(p, agent, match); }
    else if (match(p)) ingest(p, agent);
  }
}
function watch(dir, agent, match) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.watch(dir, { recursive: true }, (_, name) => { if (name && match(path.join(dir, name))) ingest(path.join(dir, name), agent); });
  } catch {
    setInterval(() => scan(dir, agent, match), 5000);
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const proxyLog = path.join(DATA_DIR, 'proxy.jsonl');

const vscodeGlobalDirs = (ext) => {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', ext, 'tasks'));
  dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', ext, 'tasks'));
  dirs.push(path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', ext, 'tasks'));
  return dirs;
};

const AGENTS = [
  { id: 'claude', name: 'Claude Code', color: '#d97757', dirs: [process.env.CLAUDE_CONFIG_DIR && path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), cfg.paths.claude, '~/.claude/projects', '~/.config/claude/projects'], match: isJsonl },
  { id: 'agy', name: 'Antigravity', color: '#4f8cff', dirs: [cfg.paths.antigravity, '~/.gemini/antigravity/brain', '~/.gemini/jetski/brain'], match: isAgy },
  { id: 'codex', name: 'Codex', color: '#10a37f', dirs: [process.env.CODEX_HOME && path.join(process.env.CODEX_HOME, 'sessions'), cfg.paths.codex, '~/.codex/sessions'], match: isJsonl },
  { id: 'gemini', name: 'Gemini CLI', color: '#4285f4', dirs: [cfg.paths.gemini, '~/.gemini/tmp'], match: isGeminiChat },
  { id: 'opencode', name: 'OpenCode', color: '#06b6d4', dirs: [process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, 'opencode', 'storage', 'message'), '~/.local/share/opencode/storage/message'], match: isJson },
  { id: 'cline', name: 'Cline', color: '#eab308', dirs: vscodeGlobalDirs('saoudrizwan.claude-dev'), match: isUiMsg },
  { id: 'roo', name: 'Roo Code', color: '#ec4899', dirs: vscodeGlobalDirs('rooveterinaryinc.roo-cline'), match: isUiMsg },
];
const META = { proxy: { name: 'Proxy', color: '#9b8cff' } }, watched = new Set();

function discover() {
  for (const ag of AGENTS) for (const d of ag.dirs) {
    if (!d) continue;
    const dir = home(d);
    if (watched.has(dir) || !fs.existsSync(dir)) continue;
    watched.add(dir);
    META[ag.id] = { name: ag.name, color: ag.color };
    scan(dir, ag.id, ag.match);
    watch(dir, ag.id, ag.match);
    console.log('detected', ag.name, dir);
  }
}

const t0 = Date.now();
discover();
setInterval(discover, 30000);
if (fs.existsSync(proxyLog)) ingest(proxyLog, 'proxy');
fs.watchFile(proxyLog, { interval: 1000 }, () => ingest(proxyLog, 'proxy'));
pruneOldEvents();
if (global.gc) global.gc();
console.log(`indexed ${events.length} requests (${turns.length} turns) from ${files.size} files in ${Date.now() - t0}ms`);

// ---------- snapshot ----------
const z = () => ({ n: 0, q: 0, i: 0, o: 0, cr: 0, cw: 0, tok: 0, cost: 0 });
const acc = (g, e, c) => { g.n++; g.i += e.i; g.o += e.o; g.cr += e.cr; g.cw += e.c5 + e.c1; g.tok += tokOf(e); g.cost += c; };
const bump = (o, a, e, c) => {
  const x = o[a] || (o[a] = { tok: 0, cost: 0, n: 0 });
  x.tok += tokOf(e); x.cost += c; x.n++;
};
const slotLabel = (idx) => {
  const m = idx * 6;
  return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
};

function snapshot() {
  const now = Date.now(), today = dkey(now), weekAgo = now - 6 * 864e5;
  const A = { all: z(), today: z(), week: z() };
  const ag = {}, models = {}, days = {};
  const slots6m = Array.from({ length: 240 }, () => ({})); // 24h * 10 (every 6 minutes)
  const active = new Set();

  // Seed days & all-time from dailyArchive (>7 days old)
  for (const dk of Object.keys(dailyArchive)) {
    const dayObj = dailyArchive[dk];
    for (const a of Object.keys(dayObj)) {
      const g = dayObj[a];
      A.all.n += g.n; A.all.q += g.q; A.all.i += g.i; A.all.o += g.o; A.all.cr += g.cr; A.all.cw += g.cw; A.all.tok += g.tok; A.all.cost += g.cost;
      const agEntry = ag[a] || (ag[a] = { all: z(), today: z(), week: z() });
      agEntry.all.n += g.n; agEntry.all.q += g.q; agEntry.all.i += g.i; agEntry.all.o += g.o; agEntry.all.cr += g.cr; agEntry.all.cw += g.cw; agEntry.all.tok += g.tok; agEntry.all.cost += g.cost;
      const d = days[dk] || (days[dk] = {});
      const x = d[a] || (d[a] = { tok: 0, cost: 0, n: 0, i: 0, o: 0, cr: 0, cw: 0, q: 0 });
      x.tok += g.tok; x.cost += g.cost; x.n += g.n; x.i += g.i; x.o += g.o; x.cr += g.cr; x.cw += g.cw; x.q += g.q;
    }
  }

  for (const e of events) {
    const c = cost(e), dk = dkey(e.t), isToday = dk === today, isWeek = e.t >= weekAgo;
    acc(A.all, e, c); if (isToday) acc(A.today, e, c); if (isWeek) acc(A.week, e, c);
    const a = ag[e.a] || (ag[e.a] = { all: z(), today: z(), week: z() });
    acc(a.all, e, c); if (isToday) acc(a.today, e, c); if (isWeek) acc(a.week, e, c);
    const mk = e.a + '|' + e.m;
    const m = models[mk] || (models[mk] = { agent: e.a, model: e.m, family: family(e.m), ...z() });
    acc(m, e, c);

    const d = days[dk] || (days[dk] = {});
    const x = d[e.a] || (d[e.a] = { tok: 0, cost: 0, n: 0, i: 0, o: 0, cr: 0, cw: 0, q: 0 });
    x.tok += tokOf(e); x.cost += c; x.n++; x.i += e.i; x.o += e.o; x.cr += e.cr; x.cw += e.c5 + e.c1;

    if (isToday) {
      const dt = new Date(e.t);
      const slot = Math.min(239, Math.floor((dt.getHours() * 60 + dt.getMinutes()) / 6));
      bump(slots6m[slot], e.a, e, c);
    }
    if (now - e.t < 5 * 60e3) active.add(e.a + ':' + e.s);
  }

  for (const t of turns) {
    const dk = dkey(t.t0);
    A.all.q++; if (dk === today) A.today.q++; if (t.t0 >= weekAgo) A.week.q++;
    const a = ag[t.a] || (ag[t.a] = { all: z(), today: z(), week: z() });
    a.all.q++; if (dk === today) a.today.q++; if (t.t0 >= weekAgo) a.week.q++;
    const d = days[dk] || (days[dk] = {});
    const x = d[t.a] || (d[t.a] = { tok: 0, cost: 0, n: 0, i: 0, o: 0, cr: 0, cw: 0, q: 0 });
    x.q++;
  }

  const keys = Object.keys(days).sort();
  const week = []; for (let k = 6; k >= 0; k--) { const key = dkey(now - k * 864e5); week.push({ label: key.slice(5), date: key, ...(days[key] || {}) }); }
  const month = []; for (let k = 29; k >= 0; k--) { const key = dkey(now - k * 864e5); month.push({ label: key.slice(5), date: key, ...(days[key] || {}) }); }
  const all = [];
  if (keys.length) {
    const s = new Date(keys[0] + 'T12:00:00').getTime();
    for (let t = s; dkey(t) <= today; t += 864e5) {
      const key = dkey(t);
      all.push({ label: key.slice(2), date: key, ...(days[key] || {}) });
    }
  }

  // Daily volume table (last 14 days, newest first)
  const daily = [];
  for (let k = 0; k < 14; k++) {
    const key = dkey(now - k * 864e5);
    const dObj = days[key] || {};
    const sum = z();
    const byAgent = {};
    for (const a of Object.keys(dObj)) {
      const v = dObj[a];
      sum.n += v.n; sum.q += v.q; sum.i += v.i; sum.o += v.o; sum.cr += v.cr; sum.cw += v.cw; sum.tok += v.tok; sum.cost += v.cost;
      byAgent[a] = { tok: v.tok, cost: v.cost, n: v.n, q: v.q };
    }
    daily.push({ date: key, ...sum, byAgent });
  }

  // Latest 100 requests for live feed
  const top = [];
  for (const e of events) {
    if (top.length < 100 || e.t > top[99].t) {
      let j = top.length; if (j === 100) j--;
      top[j] = e;
      while (j > 0 && top[j - 1].t < top[j].t) { const x = top[j]; top[j] = top[j - 1]; top[j - 1] = x; j--; }
    }
  }
  const feed = top.map(e => ({ t: e.t, a: e.a, m: e.m, i: e.i, o: e.o, cr: e.cr, cw: e.c5 + e.c1, s: e.s, cost: cost(e), turnId: e.turnId }));

  // Latest 50 turns
  const recentTurns = [...turns].sort((x, y) => y.t1 - x.t1).slice(0, 50);

  // Available 7 days for history filters
  const historyDays = [];
  for (let k = 0; k < (cfg.retentionDays || 7); k++) historyDays.push(dkey(now - k * 864e5));

  const rate = (g) => { const d = g.i + g.cr + g.cw; return d ? g.cr / d : 0; };
  const nowDt = new Date(now);
  const currentSlot = Math.min(239, Math.floor((nowDt.getHours() * 60 + nowDt.getMinutes()) / 6));

  return {
    asof: now, meta: META, count: events.length, turnCount: turns.length,
    retentionDays: cfg.retentionDays || 7, historyDays,
    thb: cfg.thbPerUsd, rss: process.memoryUsage().rss,
    totals: A, cache: { all: rate(A.all), today: rate(A.today), week: rate(A.week) },
    agents: ag, active: { n: active.size, list: [...active] },
    models: Object.values(models).sort((x, y) => y.tok - x.tok),
    currentSlot,
    series: {
      today: slots6m.map((h, i) => ({ label: slotLabel(i), endLabel: slotLabel(i + 1 === 240 ? 0 : i + 1), ...h })),
      week, month, all
    },
    daily,
    turns: recentTurns,
    feed
  };
}

// ---------- HTTP: static + SSE + 7-day history API ----------
const clients = new Set();
setInterval(() => {
  if (!dirty || !clients.size) return;
  dirty = false;
  const msg = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const r of clients) r.write(msg);
  if (global.gc) global.gc();
}, 400);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const urlPath = u.pathname;

  if (urlPath === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (urlPath === '/api/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(snapshot()));
  }
  if (urlPath === '/api/requests') {
    const day = u.searchParams.get('day') || 'all';
    const agent = u.searchParams.get('agent') || 'all';
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const page = Math.max(1, +(u.searchParams.get('page') || 1));
    const limit = Math.min(200, Math.max(10, +(u.searchParams.get('limit') || 100)));
    const filtered = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (agent !== 'all' && e.a !== agent) continue;
      if (day !== 'all' && dkey(e.t) !== day) continue;
      if (q && !e.m.toLowerCase().includes(q) && !e.s.toLowerCase().includes(q)) continue;
      filtered.push(e);
    }
    filtered.sort((a, b) => b.t - a.t);
    const total = filtered.length;
    const items = filtered.slice((page - 1) * limit, page * limit).map(e => ({
      t: e.t, a: e.a, m: e.m, i: e.i, o: e.o, cr: e.cr, cw: e.c5 + e.c1, s: e.s, cost: cost(e), turnId: e.turnId
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ total, page, limit, items }));
  }
  if (urlPath === '/api/turns') {
    const day = u.searchParams.get('day') || 'all';
    const agent = u.searchParams.get('agent') || 'all';
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const page = Math.max(1, +(u.searchParams.get('page') || 1));
    const limit = Math.min(100, Math.max(10, +(u.searchParams.get('limit') || 50)));
    const filtered = turns.filter(t => {
      if (agent !== 'all' && t.a !== agent) return false;
      if (day !== 'all' && dkey(t.t0) !== day) return false;
      if (q && !t.prompt.toLowerCase().includes(q) && !t.m.toLowerCase().includes(q) && !t.s.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => b.t1 - a.t1);
    const total = filtered.length;
    const items = filtered.slice((page - 1) * limit, page * limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ total, page, limit, items }));
  }
  if (urlPath === '/api/config' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      try {
        const j = JSON.parse(b);
        if (j.thbPerUsd) cfg.thbPerUsd = +j.thbPerUsd;
        fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
        dirty = true; res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  const f = path.join(ROOT, 'public', urlPath === '/' ? 'index.html' : path.normalize(urlPath).replace(/^(\.\.[\\/])+/, ''));
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});
server.listen(cfg.port, '127.0.0.1', () => console.log(`Token Monitor -> http://localhost:${cfg.port}`));

// ---------- optional proxy fallback ("proxyPort" in config.json, or --proxy=PORT) ----------
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
          const iTok = grab('input_tokens') || grab('prompt_tokens') || grab('promptTokenCount');
          const oTok = grab('output_tokens') || grab('completion_tokens') || grab('candidatesTokenCount');
          const crTok = grab('cache_read_input_tokens') || grab('cached_tokens') || grab('cachedContentTokenCount');
          const c5Tok = grab('cache_creation_input_tokens');
          const mm = /"model":"([^"]+)"/.exec(txt); if (mm) model = mm[1];
          if (iTok || oTok || crTok || c5Tok) {
            fs.appendFile(proxyLog, JSON.stringify({ t: Date.now(), m: model || 'unknown', i: iTok, o: oTok, cr: crTok, c5: c5Tok, c1: 0, s: 'proxy' }) + '\n', () => {});
          }
        });
      });
      preq.on('error', e => { cres.writeHead(502); cres.end(String(e)); }); preq.end(body);
    });
  }).listen(proxyPort, '127.0.0.1', () => console.log(`Proxy fallback :${proxyPort} -> ${cfg.proxyUpstream}`));
}
