import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import httpClient from 'node:http';
import WebSocket from 'ws';
import { startToolBridge } from '../../server/tool-bridge.mjs';

const origin = 'http://127.0.0.1:5173';
const open = async (url, protocols, options) => {
  const ws = new WebSocket(url, protocols, options);
  await once(ws, 'open');
  return ws;
};
const request = async (ws, message) => {
  const response = once(ws, 'message');
  ws.send(JSON.stringify(message));
  return JSON.parse((await response)[0].toString());
};

test('local bridge capabilities, origins, roles and explicit routing', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'circuit-bridge-test-'));
  const relay = await startToolBridge({ port: 0, origins: [origin], tokenFile: join(directory, 'capability') });
  const clients = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); await relay.close(); await rm(directory, { recursive: true, force: true }); });
  const port = relay.server.address().port;
  const url = `ws://127.0.0.1:${port}`;
  const http = `http://127.0.0.1:${port}`;
  const token = JSON.parse(await readFile(relay.tokenFile, 'utf8')).token;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const capability = await fetch(`${http}/tool-bridge/capability`, { headers: { Origin: origin, 'X-Circuit-Bridge': 'browser' } });
  assert.equal(capability.status, 200);
  const browserToken = (await capability.json()).token;
  const browser = async () => { const ws = await open(url, ['circuit-browser', browserToken], { origin }); clients.push(ws); return ws; };
  const tutor = await open(url, [], auth); clients.push(tutor);

  await t.test('listener is IPv4 loopback, capability is private, LAN interfaces cannot connect', async () => {
    assert.equal(relay.server.address().address, '127.0.0.1');
    assert.equal((await stat(relay.tokenFile)).mode & 0o777, 0o600);
    const addresses = Object.values(networkInterfaces()).flat().filter(i => i && !i.internal && i.family === 'IPv4');
    for (const { address } of addresses) {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: address, port });
        socket.on('connect', () => { socket.destroy(); reject(new Error('Relay reachable on LAN')); });
        socket.on('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
        socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('LAN probe timed out')); });
      });
    }
  });
  await t.test('untrusted origins and unauthenticated clients cannot obtain access', async () => {
    assert.equal((await fetch(`${http}/tool-bridge/capability`, { headers: { Origin: 'https://evil.example', 'X-Circuit-Bridge': 'browser' } })).status, 403);
    assert.equal((await fetch(`${http}/tool-bridge/capability`, { headers: { 'X-Circuit-Bridge': 'browser' } })).status, 403);
    const status = await new Promise((resolve, reject) => {
      httpClient.get(`${http}/tool-bridge/capability`, { headers: { Host: 'evil.example', Origin: origin, 'X-Circuit-Bridge': 'browser' } }, res => {
        res.resume(); resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 403);
    await assert.rejects(open(url), /403/);
    await assert.rejects(open(url, [], { headers: { Authorization: 'Bearer wrong' } }), /403/);
    await assert.rejects(open(url, ['circuit-browser', browserToken], { origin: 'https://evil.example' }), /403/);
    await assert.rejects(open(url, ['circuit-browser', 'wrong'], { origin }), /403/);
    await assert.rejects(open(url, ['circuit-browser', browserToken]), /403/);
    await assert.rejects(open(url, [], { ...auth, origin }), /403/);
    assert.equal((await fetch(`${http}/healthz`)).status, 200);
  });
  const host = await browser();
  const second = await browser();
  host.send(JSON.stringify({ type: 'register', session_id: 'tab-a', tools: [{ name: 'runDC' }] }));
  second.send(JSON.stringify({ type: 'register', session_id: 'tab-b', tools: [{ name: 'runDC' }] }));
  await t.test('legitimate registered host, tool listing and tutor calls work', async () => {
    // A successful listing also waits until the registration has been processed.
    for (let i = 0; i < 20; i++) {
      if ((await request(tutor, { type: 'list_tools', id: 1, session_id: 'tab-a' })).tools?.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual((await request(tutor, { type: 'list_tools', id: 2, session_id: 'tab-a' })).tools, [{ name: 'runDC' }]);
    const incoming = once(host, 'message');
    const result = request(tutor, { type: 'call', id: 3, session_id: 'tab-a', tool: 'runDC', input: {} });
    const call = JSON.parse((await incoming)[0]);
    second.send(JSON.stringify({ type: 'result', callId: call.callId, result: { forged: true } }));
    host.send(JSON.stringify({ type: 'result', callId: call.callId, result: { converged: true } }));
    assert.deepEqual((await result).result, { converged: true });
  });
  await t.test('missing, invalid and unknown sessions and unknown tools are rejected', async () => {
    for (const session_id of [undefined, '', '../tab-a', 'unknown']) {
      for (const type of ['call', 'list_tools']) assert.ok((await request(tutor, { type, id: 4, session_id, tool: 'runDC', input: {} })).error);
    }
    assert.match((await request(tutor, { type: 'call', id: 4, session_id: 'tab-a', tool: 'unknown', input: {} })).error, /tool/);
    second.close(); await once(second, 'close');
    assert.match((await request(tutor, { type: 'call', id: 5, tool: 'runDC', input: {} })).error, /session_id/);
  });
  await t.test('registration hijack and role escalation fail', async () => {
    const duplicate = await browser();
    const closed = once(duplicate, 'close');
    duplicate.send(JSON.stringify({ type: 'register', session_id: 'tab-a', tools: [] }));
    assert.equal((await closed)[0], 1008);
    assert.equal((await request(tutor, { type: 'list_tools', id: 6, session_id: 'tab-a' })).tools.length, 1);
    const wrongRole = await browser();
    const denied = once(wrongRole, 'close');
    wrongRole.send(JSON.stringify({ type: 'call', session_id: 'tab-a', tool: 'runDC' }));
    assert.equal((await denied)[0], 1008);
    const deniedTutor = once(tutor, 'close');
    tutor.send(JSON.stringify({ type: 'register', session_id: 'fake' }));
    assert.equal((await deniedTutor)[0], 1008);
  });
});

test('non-local origin allowlists fail closed', async () => {
  await assert.rejects(startToolBridge({ origins: ['http://0.0.0.0:5173'] }), /localhost/);
  await assert.rejects(startToolBridge({ origins: ['*'] }));
});

test('restart rotates capabilities and removes the old tutor token file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'circuit-bridge-rotation-'));
  const tokenFile = join(directory, 'capability');
  const first = await startToolBridge({ port: 0, origins: [origin], tokenFile });
  const old = JSON.parse(await readFile(tokenFile, 'utf8')).token;
  await first.close();
  await assert.rejects(readFile(tokenFile), { code: 'ENOENT' });
  const second = await startToolBridge({ port: 0, origins: [origin], tokenFile });
  t.after(async () => { await second.close(); await rm(directory, { recursive: true, force: true }); });
  const current = JSON.parse(await readFile(tokenFile, 'utf8')).token;
  assert.equal(old === current, false, 'capability must rotate');
  const url = `ws://127.0.0.1:${second.server.address().port}`;
  await assert.rejects(open(url, [], { headers: { Authorization: `Bearer ${old}` } }), /403/);
  const ws = await open(url, [], { headers: { Authorization: `Bearer ${current}` } });
  ws.close();
  await once(ws, 'close');
});
