// Relay dei tool live con routing per scheda browser. I calcoli restano nel browser.
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.TOOL_BRIDGE_PORT ?? 8787);
const hosts = new Map(); // session_id → { socket, tools }
const pending = new Map();
const send = (ws, obj) => { if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
const server = http.createServer((req, res) => {
  res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ connected: hosts.size > 0, sessions: hosts.size }));
});
const wss = new WebSocketServer({ server, maxPayload: 8_000_000 });

function failPending(socket, reason) {
  for (const [id, p] of pending) {
    if (p.host !== socket && p.client !== socket) continue;
    clearTimeout(p.timer);
    if (p.client !== socket) send(p.client, { type: 'result', id: p.reqId, error: reason });
    pending.delete(id);
  }
}

function selectHost(sessionId) {
  if (sessionId) return hosts.get(sessionId);
  // Compatibilità con client esterni legacy solo quando la destinazione è univoca.
  if (hosts.size === 1) return hosts.values().next().value;
}

wss.on('connection', (ws) => {
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'register': {
        const sessionId = msg.session_id ?? 'legacy';
        if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 200) return;
        const previous = hosts.get(sessionId);
        if (previous && previous.socket !== ws) failPending(previous.socket, 'sessione browser riconnessa');
        for (const [key, host] of hosts) if (host.socket === ws) hosts.delete(key);
        hosts.set(sessionId, { socket: ws, tools: Array.isArray(msg.tools) ? msg.tools : [] });
        break;
      }
      case 'result': {
        const p = pending.get(msg.callId);
        // Soltanto l'host scelto può rispondere alla chiamata.
        if (!p || p.host !== ws) break;
        clearTimeout(p.timer);
        pending.delete(msg.callId);
        send(p.client, { type: 'result', id: p.reqId, result: msg.result, error: msg.error });
        break;
      }
      case 'list_tools': {
        const host = selectHost(msg.session_id);
        send(ws, { type: 'tools', id: msg.id, tools: host?.tools ?? [],
          error: !host && hosts.size > 1 ? 'specificare session_id: più circuiti connessi' : undefined });
        break;
      }
      case 'call': {
        const host = selectHost(msg.session_id);
        if (!host || host.socket.readyState !== ws.OPEN) {
          send(ws, { type: 'result', id: msg.id, error: hosts.size > 1 && !msg.session_id
            ? 'specificare session_id: più circuiti connessi'
            : 'nessun circuito connesso per questa sessione: apri Circuit Studio nel browser' });
          break;
        }
        const callId = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(callId);
          send(ws, { type: 'result', id: msg.id, error: 'timeout del tool' });
        }, 15_000);
        pending.set(callId, { client: ws, host: host.socket, reqId: msg.id, timer });
        send(host.socket, { type: 'call', callId, tool: msg.tool, input: msg.input ?? {} });
        break;
      }
    }
  });
  ws.on('close', () => {
    for (const [key, host] of hosts) if (host.socket === ws) hosts.delete(key);
    failPending(ws, 'circuito disconnesso');
  });
});
server.listen(PORT, () => console.log(`Tool-bridge WS sulla porta ${PORT}`));
