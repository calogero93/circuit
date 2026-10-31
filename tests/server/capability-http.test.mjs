import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, preview } from 'vite';
import { startToolBridge } from '../../server/tool-bridge.mjs';

const root = resolve(import.meta.dirname, '../..');
const outside = path => { const rel = relative(root, path); return rel.startsWith('..') || isAbsolute(rel); };

test('actual Vite dev and preview never disclose the tutor capability', { timeout: 30_000 }, async t => {
  const relay = await startToolBridge({ port: 0 });
  t.after(() => relay.close());
  const token = JSON.parse(await readFile(relay.tokenFile, 'utf8')).token;
  const dev = await createServer({ root, configLoader: 'runner', logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => dev.close());
  await dev.listen();
  const previewDist = await mkdtemp(join(tmpdir(), 'circuit-preview-fixture-'));
  await writeFile(join(previewDist, 'index.html'), '<!doctype html><title>Preview security fixture</title>');
  const prod = await preview({ root, configLoader: 'runner', logLevel: 'silent', build: { outDir: previewDist }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  t.after(async () => { await new Promise(resolve => prod.httpServer.close(resolve)); await rm(previewDist, { recursive: true, force: true }); });
  await t.test('runtime path is outside the project and has restrictive permissions', async () => {
    assert.equal(outside(relay.tokenFile), true);
    assert.equal((await stat(relay.tokenFile)).mode & 0o777, 0o600);
    assert.equal((await stat(resolve(relay.tokenFile, '..'))).mode & 0o777, 0o700);
  });
  const variants = [
    `/.local-notes/tool-bridge-${relay.server.address().port}.token`,
    '/' + relative(root, relay.tokenFile),
    '/@fs/' + relay.tokenFile,
    '/@fs/' + relay.tokenFile.replaceAll('/', '%2f'),
    '/@fs/' + relay.tokenFile.replaceAll('/', '/./'),
    '/@fs/' + relay.tokenFile.replaceAll('.', '%2e'),
    '/%40fs/' + relay.tokenFile,
  ];
  for (const [name, server] of [['dev', dev.httpServer], ['preview', prod.httpServer]]) {
    await t.test(`${name}: ordinary, @fs, encoded and normalized paths are safe across origins`, async () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      for (const path of variants) {
        for (const origin of [undefined, 'http://untrusted.localhost:9999']) {
          const response = await fetch(url + path, { headers: origin ? { Origin: origin } : {} });
          // Compare only booleans: a failing test must never print a capability.
          assert.equal((await response.text()).includes(token), false, `${name}: secret disclosed`);
          if (origin) assert.notEqual(response.headers.get('access-control-allow-origin'), origin);
        }
      }
    });
  }
});
