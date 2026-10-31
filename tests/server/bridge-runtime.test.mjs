import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runtimeDirectory, readTutorCapability, PROJECT_ROOT } from '../../server/bridge-runtime.mjs';
import { startToolBridge } from '../../server/tool-bridge.mjs';

// Each Node test file has its own process; restore environment after each test.
test('private XDG runtime preferred, unsafe XDG rejected, secure temporary fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'circuit-runtime-regression-'));
  const previous = process.env.XDG_RUNTIME_DIR;
  t.after(async () => { if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous; await rm(directory, { recursive: true, force: true }); });
  process.env.XDG_RUNTIME_DIR = directory;
  assert.equal(relative(directory, runtimeDirectory()).startsWith('..'), false);
  const relay = await startToolBridge({ port: 0 });
  assert.equal((await readTutorCapability(relay.server.address().port)).length, 64);
  await relay.close();
  const unsafe = join(directory, 'unsafe');
  await mkdir(unsafe);
  await chmod(unsafe, 0o755);
  process.env.XDG_RUNTIME_DIR = unsafe;
  assert.notEqual(runtimeDirectory().startsWith(unsafe + '/'), true);
  delete process.env.XDG_RUNTIME_DIR;
  assert.ok(runtimeDirectory().startsWith(tmpdir() + '/'));
  const fallback = await startToolBridge({ port: 0 });
  assert.equal((await readTutorCapability(fallback.server.address().port)).length, 64);
  await fallback.close();
});

test('capability overrides inside the project are rejected', async () => {
  await assert.rejects(startToolBridge({ port: 0, tokenFile: join(PROJECT_ROOT, '.local-notes', 'must-not-be-created.token') }), /esterno/);
});
