// Relay WebSocket per esporre i tool del circuito (seam §4.5) a client esterni
// (es. un sistema multiagente Python). I tool NON girano qui: leggono lo stato
// vivo del browser (store + simulazione in corso), quindi l'esecutore è il
// browser. Questo relay fa da rendez-vous:
//
//   [ Browser: host, esegue i tool ]  ⇄  relay  ⇄  [ Client Python: chiama i tool ]
//
// Protocollo (JSON su WS):
//   Client → relay:  { "type":"list_tools", "id":<n> }
//                    { "type":"call", "id":<n>, "tool":"runDC", "input":{...} }
//   relay → Client:  { "type":"tools", "id":<n>, "tools":[...schemi...] }
//                    { "type":"result", "id":<n>, "result":{...} | "error":"..." }
//
// Il browser si registra da solo (register) e risponde alle call inoltrate.

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.TOOL_BRIDGE_PORT ?? 8787);
const CALL_TIMEOUT_MS = 15_000;

const wss = new WebSocketServer({ port: PORT });

let host = null; // il browser che esegue i tool
let hostTools = []; // schemi tool ricevuti dall'host
const pending = new Map(); // callId → { client, reqId, timer }

const send = (ws, obj) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

function failPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    send(p.client, { type: 'result', id: p.reqId, error: reason });
  }
  pending.clear();
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      // il browser si annuncia come esecutore dei tool
      case 'register':
        host = ws;
        hostTools = Array.isArray(msg.tools) ? msg.tools : [];
        console.log(`host connesso (${hostTools.length} tool disponibili)`);
        break;

      // risposta del browser a una call inoltrata
      case 'result': {
        const p = pending.get(msg.callId);
        if (!p) break;
        clearTimeout(p.timer);
        pending.delete(msg.callId);
        send(p.client, { type: 'result', id: p.reqId, result: msg.result, error: msg.error });
        break;
      }

      // client: chiede gli schemi dei tool
      case 'list_tools':
        send(ws, { type: 'tools', id: msg.id, tools: hostTools });
        break;

      // client: invoca un tool → inoltra all'host
      case 'call': {
        if (!host || host.readyState !== host.OPEN) {
          send(ws, { type: 'result', id: msg.id, error: 'nessun circuito connesso: apri Circuit Studio nel browser' });
          break;
        }
        const callId = randomUUID();
        const timer = setTimeout(() => {
          if (pending.has(callId)) {
            pending.delete(callId);
            send(ws, { type: 'result', id: msg.id, error: 'timeout del tool' });
          }
        }, CALL_TIMEOUT_MS);
        pending.set(callId, { client: ws, reqId: msg.id, timer });
        send(host, { type: 'call', callId, tool: msg.tool, input: msg.input ?? {} });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws === host) {
      host = null;
      hostTools = [];
      console.log('host disconnesso');
      failPending('circuito disconnesso');
    }
  });
});

console.log(`Tool-bridge WS su ws://localhost:${PORT}  (browser = host · client = multiagent)`);
