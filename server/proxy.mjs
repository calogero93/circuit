// Proxy minimale per il tutor AI (unica parte server di M1, seam §4.5).
// La chiave ANTHROPIC_API_KEY vive SOLO qui: il client parla con /api/chat,
// mai direttamente con l'API Anthropic. Il loop di tool-use resta lato client
// (i tool leggono la simulazione, che gira nel browser).

import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

const PORT = Number(process.env.PORT ?? 8786);
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';
const MAX_BODY = 1_000_000; // 1 MB: le conversazioni del tutor sono piccole

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY mancante: esportala o mettila in .env prima di avviare il proxy.');
  process.exit(1);
}

const client = new Anthropic();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body troppo grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/chat') {
    send(res, 404, { error: 'not found' });
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, { error: 'JSON non valido' });
    return;
  }
  const { system, messages, tools } = body ?? {};
  if (typeof system !== 'string' || !Array.isArray(messages) || !Array.isArray(tools)) {
    send(res, 400, { error: 'attesi: system (string), messages (array), tools (array)' });
    return;
  }

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system,
      messages,
      tools,
    });
    send(res, 200, {
      content: response.content,
      stop_reason: response.stop_reason,
      model: response.model,
      usage: response.usage,
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      send(res, 429, { error: 'rate limit: riprova tra qualche secondo' });
    } else if (error instanceof Anthropic.AuthenticationError) {
      send(res, 502, { error: 'chiave API non valida sul server' });
    } else if (error instanceof Anthropic.APIError) {
      send(res, 502, { error: `errore API (${error.status}): ${error.message}` });
    } else {
      send(res, 500, { error: 'errore interno del proxy' });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Proxy tutor AI su http://localhost:${PORT} (modello: ${MODEL})`);
});
