#!/usr/bin/env node
// Hook do Claude Code: lê o evento do stdin, envia um RESUMO ao painel local.
// Nunca bloqueia o Claude Code: qualquer falha sai com código 0.
// No SessionStart, se o painel não estiver rodando, sobe o server.js em segundo plano.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.SQUAD_PANEL_PORT) || 4000;
const MAX_TEXT = 4000;

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let e;
  try { e = JSON.parse(raw); } catch { process.exit(0); }

  const ti = e.tool_input || {};
  const tr = e.tool_response && typeof e.tool_response === 'object' ? e.tool_response : {};
  const cut = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : undefined);
  const tag = (s, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s); return m ? m[1].trim() : undefined; };
  const isAgentTool = e.tool_name === 'Agent' || e.tool_name === 'Task';

  // Texto devolvido pela ferramenta Agent (string, ou lista de blocos { type: 'text', text }).
  const toolText = () => {
    const c = typeof e.tool_response === 'string' ? e.tool_response : tr.content ?? tr.result;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n').trim();
    return undefined;
  };

  // Só campos necessários para o desenho: sem conteúdo de arquivos.
  const ev = {
    event: e.hook_event_name,
    session: e.session_id,
    cwd: e.cwd,
    agentId: e.agent_id,
    agentType: e.agent_type,
    tool: e.tool_name,
    toolUseId: e.tool_use_id,
    subagent: ti.subagent_type,
    background: ti.run_in_background === true || undefined,
    resultAgentId: tr.agentId || tr.agent_id,
    detail: cut(ti.description, 80) || cut(ti.file_path, 120) || cut(ti.command, 80) || cut(ti.pattern, 60),
    // Transcripts: o server lê para somar tokens e pegar o relatório final do subagente.
    transcriptPath: e.transcript_path,
    agentTranscriptPath: e.agent_transcript_path,
  };
  if (isAgentTool && e.hook_event_name === 'PreToolUse') ev.taskPrompt = cut(ti.prompt, MAX_TEXT);
  if (isAgentTool && e.hook_event_name === 'PostToolUse') ev.result = cut(toolText(), MAX_TEXT);

  // Retornos de subagentes em segundo plano chegam como "prompts" do usuário.
  // Eles são marcados como internos para o painel não confundir com um pedido novo.
  const p = typeof e.prompt === 'string' ? e.prompt.trim() : '';
  if (p.startsWith('<task-notification>')) {
    Object.assign(ev, {
      internal: 'task-notification',
      fromAgentId: tag(p, 'task-id'),
      status: tag(p, 'status'),
      prompt: cut(tag(p, 'summary'), 140),
      result: cut(tag(p, 'result'), MAX_TEXT),
    });
  } else if (p.startsWith('<agent-message')) {
    const from = /from="([^"]+)"/.exec(p);
    Object.assign(ev, {
      internal: 'agent-message',
      fromAgentId: from && from[1],
      result: cut(p.replace(/^<agent-message[^>]*>/, '').replace(/<\/agent-message>\s*$/, '').trim(), MAX_TEXT),
    });
  } else if (p) {
    ev.prompt = cut(p, 140);
  }

  send(ev, (ok) => {
    if (ok || ev.event !== 'SessionStart') process.exit(0);
    startServer(e.cwd);
    setTimeout(() => send(ev, () => process.exit(0)), 900);
  });
});

function send(ev, done) {
  const data = JSON.stringify(ev);
  const req = http.request({
    host: '127.0.0.1',
    port: PORT,
    path: '/event',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    timeout: 1000,
  }, (r) => { r.resume(); r.on('end', () => done(true)); });
  req.on('error', () => done(false));
  req.on('timeout', () => { req.destroy(); });
  req.end(data);
}

// Sobe o painel desacoplado do Claude Code (continua rodando depois que o hook termina).
function startServer(cwd) {
  if (process.env.SQUAD_PANEL_AUTOSTART === '0') return;
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), cwd || process.cwd()], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch { /* sem painel: segue a vida */ }
}
