// Servidor local do painel: lê .claude/agents, recebe eventos dos hooks, guarda o histórico
// e repassa ao navegador (SSE). Sem dependências: rode com `node server.js [pasta-do-projeto]`.
// A pasta do projeto também pode vir de SQUAD_PROJECT_DIR; sem nenhuma das duas, usa a pasta atual.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.SQUAD_PANEL_PORT) || 4000;
const ROOT = path.resolve(process.argv[2] || process.env.SQUAD_PROJECT_DIR || process.cwd());
const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');
const HISTORY_DIR = path.resolve(process.env.SQUAD_HISTORY_DIR || path.join(os.homedir(), '.squad-panel', 'historico'));
const MAX_RUNS = 300;           // execuções guardadas no histórico
const MAX_EVENTS = 5000;        // eventos por execução
const RESUME_WINDOW = 30 * 60e3; // após reiniciar o server, eventos de uma sessão retomam a última execução dela

const clients = new Set();
let agents = [];
let agentsSig = '';

// ---------- Leitura de .claude/agents ----------

// Frontmatter YAML simples: `chave: valor`, valores entre aspas e blocos `|` / `>`.
function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let [, key, val] = kv;
    if (/^[|>][+-]?$/.test(val)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      val = block.join(val[0] === '|' ? '\n' : ' ').trim();
    } else if (/^(["']).*\1$/.test(val)) {
      val = val.slice(1, -1).replace(/\\n/g, '\n');
    }
    out[key] = val;
  }
  return out;
}

function readAgents() {
  let files = [];
  try { files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  const list = [];
  for (const f of files) {
    try {
      const fm = parseFrontmatter(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
      list.push({ id: fm.name || path.basename(f, '.md'), description: fm.description || '', model: fm.model || '', file: f });
    } catch { /* arquivo ilegível: ignora */ }
  }
  return list;
}

// Assinatura barata (nome + data de alteração) para perceber arquivos criados, editados ou apagados.
function signature() {
  try {
    return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))
      .map((f) => f + ':' + fs.statSync(path.join(AGENTS_DIR, f)).mtimeMs).sort().join('|');
  } catch { return ''; }
}

function refreshAgents(force) {
  const sig = signature();
  if (!force && sig === agentsSig) return;
  agentsSig = sig;
  agents = readAgents();
  broadcast(agentsEvent());
  console.log(`Agentes em ${AGENTS_DIR}: ${agents.map((a) => a.id).join(', ') || '(nenhum)'}`);
}
const agentsEvent = () => ({ event: 'AgentsConfig', agents, root: ROOT, ts: Date.now() });

// Polling em vez de fs.watch: funciona igual no Windows, macOS e Linux, e aguenta a pasta ser criada depois.
setInterval(() => refreshAgents(false), 2000);

// ---------- Preços e tokens ----------

// US$ por milhão de tokens (API da Anthropic). Cache: escrita 1,25× a entrada; leitura conforme a tabela.
// Para ajustar, crie precos.json ao lado deste arquivo: { "claude-sonnet-5": { "input": 2, "output": 10, "cacheRead": 0.2 } }
const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
};
try { Object.assign(PRICES, JSON.parse(fs.readFileSync(path.join(__dirname, 'precos.json'), 'utf8'))); } catch { /* opcional */ }
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

function priceOf(model) {
  const m = String(model || '').toLowerCase().replace(/^.*?(claude-)/, '$1');
  const key = PRICE_KEYS.find((k) => m.startsWith(k));
  if (!key) return null;
  const p = PRICES[key];
  return { input: p.input, output: p.output, cacheWrite: p.cacheWrite ?? p.input * 1.25, cacheRead: p.cacheRead ?? p.input * 0.1 };
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: true, models: [] });
function addUsage(total, u) {
  if (!u) return total;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) total[k] += u[k] || 0;
  total.priced = total.priced && u.priced !== false;
  for (const m of u.models || []) if (!total.models.includes(m)) total.models.push(m);
  return total;
}
// Converte o objeto `usage` da API para o formato do painel.
function fromApiUsage(u, model) {
  const out = emptyUsage();
  out.input = u.input_tokens || 0;
  out.output = u.output_tokens || 0;
  out.cacheRead = u.cache_read_input_tokens || 0;
  out.cacheWrite = u.cache_creation_input_tokens || 0;
  const p = priceOf(model);
  if (p) out.cost = (out.input * p.input + out.output * p.output + out.cacheRead * p.cacheRead + out.cacheWrite * p.cacheWrite) / 1e6;
  else out.priced = false;
  if (model) out.models.push(model);
  return out;
}

// Lê um transcript (.jsonl) do Claude Code: soma o uso de cada mensagem do assistente
// (a mesma mensagem aparece em várias linhas; vale a última) e pega o texto final.
async function readTranscript(file, { since = 0, mainOnly = false } = {}) {
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch { return null; }
  const msgs = new Map();
  let lastId = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'assistant' || !r.message) continue;
    if (mainOnly && r.isSidechain) continue;
    if (since && r.timestamp && Date.parse(r.timestamp) < since) continue;
    const id = r.message.id || r.uuid;
    const m = msgs.get(id) || { usage: null, model: r.message.model, text: [] };
    if (r.message.usage) m.usage = r.message.usage;
    for (const b of Array.isArray(r.message.content) ? r.message.content : []) if (b && b.type === 'text' && b.text) m.text.push(b.text);
    msgs.set(id, m);
    lastId = id;
  }
  const usage = emptyUsage();
  for (const m of msgs.values()) if (m.usage && m.model !== '<synthetic>') addUsage(usage, fromApiUsage(m.usage, m.model));
  const last = lastId && msgs.get(lastId);
  return { usage, lastText: last ? last.text.join('\n').trim() : '' };
}

function subagentTranscript(ev) {
  const candidates = [ev.agentTranscriptPath];
  if (ev.transcriptPath && ev.agentId) {
    const dir = path.dirname(ev.transcriptPath);
    candidates.push(path.join(dir, ev.session || '', 'subagents', `agent-${ev.agentId}.jsonl`));
    candidates.push(path.join(dir, `agent-${ev.agentId}.jsonl`));
  }
  return candidates.find((f) => f && fs.existsSync(f));
}

// ---------- Execuções (uma por prompt, separadas por sessão) ----------

const runs = new Map();       // id -> { meta, events }
const current = new Map();    // sessão -> id da execução atual
const sessions = new Map();   // sessão -> { id, cwd, lastSeen }

function newMeta(id, ev) {
  return {
    id, session: ev.session || 'sem-sessao', cwd: ev.cwd || '', prompt: ev.prompt || '',
    start: ev.ts, last: ev.ts, end: 0, status: 'running', events: 0, agents: [],
    usage: emptyUsage(), mainUsage: null, agentUsage: {}
  };
}

// Atualiza o resumo da execução com um evento (usado ao vivo e ao carregar o histórico).
function applyMeta(meta, ev) {
  meta.events++;
  meta.last = Math.max(meta.last, ev.ts);
  if (ev.cwd && !meta.cwd) meta.cwd = ev.cwd;
  if (ev.event === 'Stop' && !ev.agentId) { meta.status = 'done'; meta.end = ev.ts; }
  else if (ev.event !== 'Usage') meta.status = 'running';
  const who = ev.event === 'PreToolUse' && /^(Agent|Task)$/.test(ev.tool) ? ev.subagent : null;
  if (who && !meta.agents.includes(who)) meta.agents.push(who);
  if (ev.event === 'Usage') {
    if (ev.main) meta.mainUsage = ev.usage;
    else meta.agentUsage[ev.agentId || ev.toolUseId] = ev.usage;
    meta.usage = emptyUsage();
    addUsage(meta.usage, meta.mainUsage);
    for (const u of Object.values(meta.agentUsage)) addUsage(meta.usage, u);
  }
}
const publicMeta = (m) => {
  const { agentUsage, mainUsage, ...rest } = m;
  return { ...rest, live: current.get(m.session) === m.id };
};

function runId(ev) {
  const d = new Date(ev.ts);
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${(ev.session || 'sem').slice(0, 8)}`;
  let id = base, i = 1;
  while (runs.has(id)) id = `${base}-${i++}`;
  return id;
}

function runFor(ev) {
  const s = ev.session || 'sem-sessao';
  const fresh = ev.event === 'UserPromptSubmit' && !ev.internal;
  let id = current.get(s);
  if (!id && !fresh) {
    // Server reiniciado no meio de uma sessão: retoma a última execução dela, se for recente.
    const prev = [...runs.values()].filter((r) => r.meta.session === s).sort((a, b) => b.meta.start - a.meta.start)[0];
    if (prev && ev.ts - prev.meta.last < RESUME_WINDOW) id = prev.meta.id;
  }
  if (fresh || !id) {
    const old = id && runs.get(id);
    id = runId(ev);
    runs.set(id, { meta: newMeta(id, ev), events: [] });
    current.set(s, id);
    if (old) broadcast({ event: 'RunMeta', run: publicMeta(old.meta) });
    pruneRuns();
  } else {
    current.set(s, id);
  }
  return runs.get(id);
}

function record(run, ev) {
  ev.runId = run.meta.id;
  ev.seq = run.events.length;
  if (run.events.length < MAX_EVENTS) run.events.push(ev);
  applyMeta(run.meta, ev);
  try { fs.appendFileSync(path.join(HISTORY_DIR, run.meta.id + '.jsonl'), JSON.stringify(ev) + '\n'); } catch { /* sem disco: segue só em memória */ }
  broadcast(ev);
  broadcast({ event: 'RunMeta', run: publicMeta(run.meta) });
}

function pruneRuns() {
  const all = [...runs.values()].sort((a, b) => b.meta.start - a.meta.start);
  for (const r of all.slice(MAX_RUNS)) {
    runs.delete(r.meta.id);
    try { fs.unlinkSync(path.join(HISTORY_DIR, r.meta.id + '.jsonl')); } catch { /* já apagado */ }
  }
}

function loadHistory() {
  try { fs.mkdirSync(HISTORY_DIR, { recursive: true }); } catch { return; }
  let files = [];
  try { files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.jsonl')).sort().slice(-MAX_RUNS); } catch { return; }
  for (const f of files) {
    try {
      const events = fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (!events.length) continue;
      const id = path.basename(f, '.jsonl');
      const meta = newMeta(id, events[0]);
      meta.events = 0;
      for (const ev of events) applyMeta(meta, ev);
      runs.set(id, { meta, events });
    } catch { /* arquivo corrompido: ignora */ }
  }
  console.log(`Histórico: ${runs.size} execução(ões) em ${HISTORY_DIR}`);
}

// ---------- Eventos ----------

// Caminhos absolutos dentro do projeto viram relativos, para os logs ficarem legíveis.
const rootNorm = ROOT.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '') + '/';
function shortenPath(s) {
  if (typeof s !== 'string') return s;
  const norm = s.replace(/\\/g, '/');
  const i = norm.toLowerCase().indexOf(rootNorm);
  return i === -1 ? s : s.slice(0, i) + norm.slice(i + rootNorm.length);
}

function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(line);
}

function receive(input) {
  const { transcriptPath, agentTranscriptPath, ...ev } = input;
  ev.ts = Date.now();
  ev.detail = shortenPath(ev.detail);
  if (ev.session) {
    const s = sessions.get(ev.session) || { id: ev.session, cwd: ev.cwd || '' };
    s.lastSeen = ev.ts;
    if (ev.cwd) s.cwd = ev.cwd;
    sessions.set(ev.session, s);
  }
  if (ev.event === 'SessionStart') { broadcast({ event: 'Session', session: sessions.get(ev.session), ts: ev.ts }); return; }

  const run = runFor(ev);
  record(run, ev);
  const ctx = { ...ev, transcriptPath, agentTranscriptPath };

  // Tokens do subagente: o transcript dele é gravado ao terminar; espera um instante antes de ler.
  if (ev.event === 'SubagentStop') {
    setTimeout(async () => {
      const file = subagentTranscript(ctx);
      const t = file && await readTranscript(file);
      if (t) record(run, { event: 'Usage', agentId: ev.agentId, agentType: ev.agentType, usage: t.usage, result: t.lastText.slice(0, 6000), source: 'transcript', ts: Date.now() });
    }, 300);
  }
  // Tokens do orquestrador nesta execução: só as mensagens da sessão principal desde o prompt.
  if (ev.event === 'Stop' && !ev.agentId && transcriptPath) {
    setTimeout(async () => {
      const t = await readTranscript(transcriptPath, { since: run.meta.start - 1000, mainOnly: true });
      if (t) record(run, { event: 'Usage', main: true, usage: t.usage, source: 'transcript', ts: Date.now() });
    }, 300);
  }
}

// ---------- HTTP ----------

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }
  const json = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const url = req.url.split('?')[0];

  if (req.method === 'POST' && url === '/event') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let ev;
      try { ev = JSON.parse(body || '{}'); } catch { res.statusCode = 400; return res.end('json inválido'); }
      receive(ev);
      res.end('ok');
    });
    return;
  }

  if (url === '/agents') return json({ root: ROOT, agents });

  if (url === '/runs') {
    return json({
      runs: [...runs.values()].map((r) => publicMeta(r.meta)).sort((a, b) => b.start - a.start),
      sessions: [...sessions.values()],
    });
  }

  const m = /^\/runs\/([\w-]+)$/.exec(url);
  if (m) {
    const r = runs.get(m[1]);
    return r ? json({ run: publicMeta(r.meta), events: r.events }) : json({ erro: 'execução não encontrada' }, 404);
  }

  if (url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': conectado\n\n');
    res.write(`data: ${JSON.stringify({ event: 'Hello', ts: Date.now() })}\n\n`);
    res.write(`data: ${JSON.stringify(agentsEvent())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'dashboard.html')).pipe(res);
  }

  res.statusCode = 404;
  res.end();
});

setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000);

loadHistory();
refreshAgents(true);
server.on('error', (err) => {
  // Outro painel já está na porta (ex.: subido pelo hook de SessionStart): sai sem barulho.
  if (err.code === 'EADDRINUSE') { console.log(`Porta ${PORT} já em uso: o painel provavelmente já está rodando.`); process.exit(0); }
  throw err;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Painel da squad em http://localhost:${PORT}`);
});
