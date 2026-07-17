// Connettore lato browser al tool-bridge (server/tool-bridge.mjs): registra i
// tool ed esegue le chiamate provenienti da un client esterno (es. multiagente
// Python) usando lo stato VIVO del circuito. Opt-in: si attiva solo se è definito
// un URL (via VITE_TOOL_BRIDGE_URL o chiamando connectToolBridge(url)).

import { TOOL_DEFINITIONS, executeTool } from './tools.ts';

let socket: WebSocket | null = null;
let retryTimer: number | undefined;

/** Connette (e riconnette) al relay; no-op se non c'è un URL. */
export function connectToolBridge(url = import.meta.env.VITE_TOOL_BRIDGE_URL as string | undefined): void {
  if (!url) return;
  clearTimeout(retryTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    retryTimer = window.setTimeout(() => connectToolBridge(url), 3000);
    return;
  }
  socket = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'register', tools: TOOL_DEFINITIONS }));
  };

  ws.onmessage = (ev) => {
    let msg: { type?: string; callId?: string; tool?: string; input?: Record<string, unknown> };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === 'call' && msg.tool && msg.callId) {
      const result = executeTool(msg.tool, msg.input ?? {}); // non lancia mai
      ws.send(JSON.stringify({ type: 'result', callId: msg.callId, result }));
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    retryTimer = window.setTimeout(() => connectToolBridge(url), 3000);
  };
  ws.onerror = () => ws.close();
}
