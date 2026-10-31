// Local relay: capabilities authorize roles; session_id only selects a browser tab.
import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { writeFile, readFile, unlink, rename, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capabilityPath, prepareRuntimeDirectory, ensurePrivateDirectory, PROJECT_ROOT } from './bridge-runtime.mjs';

const DEFAULT_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173'];
const validSession = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const matches = (value, secret) => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(secret) &&
  timingSafeEqual(Buffer.from(value), Buffer.from(secret));
const send = (ws, obj) => { if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

export async function startToolBridge({
  port = Number(process.env.TOOL_BRIDGE_PORT ?? 8787),
  origins = (process.env.TOOL_BRIDGE_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS.join(',')).split(','),
  tokenFile,
} = {}) {
  const allowedOrigins = new Set(origins.map((origin) => {
    const url = new URL(origin.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.origin !== origin.trim()) {
      throw new Error('TOOL_BRIDGE_ALLOWED_ORIGINS deve contenere origini localhost esplicite, senza path o wildcard');
    }
    return url.origin;
  }));
  const browserToken = randomBytes(32).toString('hex');
  const tutorToken = randomBytes(32).toString('hex');
  const hosts = new Map();
  const pending = new Map();
  function localHost(req) {
    try { return ['127.0.0.1', 'localhost'].includes(new URL(`http://${req.headers.host}`).hostname); }
    catch { return false; }
  }
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!localHost(req)) { res.writeHead(403).end(); return; }
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: hosts.size > 0, sessions: hosts.size }));
      return;
    }
    if (req.url !== '/tool-bridge/capability') { res.writeHead(404).end(); return; }
    const origin = req.headers.origin;
    if (origin ? !allowedOrigins.has(origin) : req.headers['sec-fetch-site'] !== 'same-origin') {
      res.writeHead(403).end(); return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS' && origin) {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'X-Circuit-Bridge' }).end();
      return;
    }
    if (req.method !== 'GET' || req.headers['x-circuit-bridge'] !== 'browser') { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: browserToken }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8_000_000,
    handleProtocols: (protocols) => protocols.has('circuit-browser') ? 'circuit-browser' : false });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim());
    let role;
    if (localHost(req) && origin && allowedOrigins.has(origin) && protocols[0] === 'circuit-browser' && matches(protocols[1], browserToken)) role = 'browser';
    if (localHost(req) && !origin && matches(req.headers.authorization, `Bearer ${tutorToken}`)) role = 'tutor';
    if (!role || !['/', '/tool-bridge'].includes(req.url) || wss.clients.size >= 64) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, role));
  });
  function failPending(socket, reason) {
    for (const [id, p] of pending) {
      if (p.host !== socket && p.client !== socket) continue;
      clearTimeout(p.timer);
      if (p.client !== socket) send(p.client, { type: 'result', id: p.reqId, error: reason });
      pending.delete(id);
    }
  }
  wss.on('connection', (ws, role) => {
    ws.on('error', () => {});
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (role === 'browser') {
        if (msg.type === 'register') {
          if (!validSession(msg.session_id) || hosts.has(msg.session_id) && hosts.get(msg.session_id).socket !== ws) {
            ws.close(1008, 'session_id mancante, non valido o già registrato'); return;
          }
          if ([...hosts.values()].some(h => h.socket === ws)) return;
          const tools = Array.isArray(msg.tools) ? msg.tools.slice(0, 32).filter(t => t && typeof t.name === 'string' && t.name.length <= 100) : [];
          hosts.set(msg.session_id, { socket: ws, tools });
        } else if (msg.type === 'result') {
          const p = pending.get(msg.callId);
          if (!p || p.host !== ws) return;
          clearTimeout(p.timer);
          pending.delete(msg.callId);
          send(p.client, { type: 'result', id: p.reqId, result: msg.result, error: msg.error });
        } else ws.close(1008, 'ruolo browser non autorizzato');
        return;
      }
      if (!['call', 'list_tools'].includes(msg.type)) { ws.close(1008, 'ruolo tutor non autorizzato'); return; }
      const reply = { type: msg.type === 'call' ? 'result' : 'tools', id: msg.id };
      if (!validSession(msg.session_id)) { send(ws, { ...reply, error: 'specificare session_id valido' }); return; }
      const host = hosts.get(msg.session_id);
      if (!host || host.socket.readyState !== ws.OPEN) { send(ws, { ...reply, error: 'nessun circuito connesso per questa sessione: apri KirchForge nel browser' }); return; }
      if (msg.type === 'list_tools') { send(ws, { ...reply, tools: host.tools }); return; }
      if (!host.tools.some(t => t.name === msg.tool) || !msg.input || typeof msg.input !== 'object' || Array.isArray(msg.input)) {
        send(ws, { ...reply, error: 'tool o input non valido' }); return;
      }
      if (pending.size >= 32) { send(ws, { ...reply, error: 'troppe richieste tool in corso' }); return; }
      const callId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(callId);
        send(ws, { ...reply, error: 'timeout del tool' });
      }, 15_000);
      pending.set(callId, { client: ws, host: host.socket, reqId: msg.id, timer });
      send(host.socket, { type: 'call', callId, tool: msg.tool, input: msg.input });
    });
    ws.on('close', () => {
      for (const [key, host] of hosts) if (host.socket === ws) hosts.delete(key);
      failPending(ws, 'circuito disconnesso');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  let temporary;
  try {
    if (!tokenFile) { prepareRuntimeDirectory(); tokenFile = capabilityPath(actualPort); }
    tokenFile = resolve(tokenFile);
    if (tokenFile === PROJECT_ROOT || tokenFile.startsWith(PROJECT_ROOT + sep)) throw new Error('Il file capability deve essere esterno al progetto');
    ensurePrivateDirectory(dirname(tokenFile));
    tokenFile = resolve(await realpath(dirname(tokenFile)), basename(tokenFile));
    if (tokenFile === PROJECT_ROOT || tokenFile.startsWith(PROJECT_ROOT + sep)) throw new Error('Il file capability deve essere esterno al progetto');
    temporary = `${tokenFile}.${randomUUID()}.tmp`;
    const existing = await lstat(tokenFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || process.getuid && existing.uid !== process.getuid())) throw new Error('File capability non sicuro');
    await writeFile(temporary, JSON.stringify({ version: 1, port: actualPort, pid: process.pid, token: tutorToken }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, tokenFile);
  } catch (error) { if (temporary) await unlink(temporary).catch(() => {}); await new Promise(resolve => server.close(resolve)); throw error; }
  return { server, tokenFile, async close() {
    for (const ws of wss.clients) ws.terminate();
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    let record;
    try { record = JSON.parse(await readFile(tokenFile, 'utf8')); } catch { return; }
    if (record.token === tutorToken) await unlink(tokenFile);
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const relay = await startToolBridge();
  console.log(`Tool-bridge WS su 127.0.0.1:${relay.server.address().port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); process.exit(0); });
}
