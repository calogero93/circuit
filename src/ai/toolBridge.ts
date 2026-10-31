// Connettore lato browser al tool-bridge (server/tool-bridge.mjs): registra i
// tool ed esegue le chiamate provenienti da LangGraph usando lo stato live.
// Default: /tool-bridge sullo stesso host (proxy WS); URL sovrascrivibile.

import { TOOL_DEFINITIONS, executeTool } from './tools.ts';
import { browserSessionId } from './contracts.ts';

let socket: WebSocket | null = null;
let retryTimer: number | undefined;
let connecting = false;

/** Connette (e riconnette) al relay; no-op se non c'è un URL. */
export async function connectToolBridge(url = import.meta.env.VITE_TOOL_BRIDGE_URL as string | undefined ??
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/tool-bridge`): Promise<void> {
  if (!url) return;
  clearTimeout(retryTimer);
  if (connecting || socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  let ws: WebSocket;
  connecting = true;
  try {
    const endpoint = new URL('/tool-bridge/capability', url);
    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    const response = await fetch(endpoint, { headers: { 'X-Circuit-Bridge': 'browser' }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Bridge non disponibile');
    const { token } = await response.json() as { token: string };
    ws = new WebSocket(url, ['circuit-browser', token]);
  } catch {
    retryTimer = window.setTimeout(() => connectToolBridge(url), 3000);
    return;
  } finally {
    connecting = false;
  }
  socket = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'register', session_id: browserSessionId(), tools: TOOL_DEFINITIONS }));
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
