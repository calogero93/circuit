import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { thirdPartyNotices } from '../../build/thirdPartyNotices.ts';

const root = resolve(import.meta.dirname, '../..');
function generate(modules) {
  const artifacts = [];
  const plugin = thirdPartyNotices(root);
  plugin.generateBundle.call({
    emitFile(value) { artifacts.push(value); },
    error(message) { throw new Error(message); },
  }, {}, { chunk: { type: 'chunk', modules } });
  return artifacts;
}

test('browser notices preserve project MIT, React, omitted Fiber license and separate KaTeX font attribution', async () => {
  const modules = Object.fromEntries(['react', '@react-three/fiber', 'katex'].map(name =>
    [join(root, 'node_modules', name, 'index.js'), { renderedLength: 10 }]));
  modules[join(root, 'node_modules/not-bundled/index.js')] = { renderedLength: 0 };
  const artifacts = generate(modules);
  assert.equal(artifacts.find(value => value.fileName === 'LICENSE').source, await readFile(join(root, 'LICENSE'), 'utf8'));
  const artifact = artifacts.find(value => value.fileName === 'THIRD_PARTY_NOTICES.txt');
  assert.equal(artifact.fileName, 'THIRD_PARTY_NOTICES.txt');
  assert.match(artifact.source, /Copyright \(c\) Meta Platforms/);
  assert.match(artifact.source, /Copyright \(c\) 2019-2025 Poimandres/);
  assert.match(artifact.source, /Copyright \(c\) 2018 Khan Academy/);
  assert.match(artifact.source, /Permission is hereby granted/);
  assert.equal(artifact.source.includes('not-bundled'), false);
});

test('a new retained dependency cannot silently ship without license text; NOTICE is retained', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'license-fixture-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const directory = join(fixture, 'node_modules/outer/node_modules/example');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'example', version: '1.0', license: 'MIT' }));
  const modules = { [join(directory, 'index.js')]: { renderedLength: 10 } };
  assert.throws(() => generate(modules), /Missing upstream license text for example@1.0/);
  await writeFile(join(directory, 'LICENSE'), 'Verified upstream permission text');
  await writeFile(join(directory, 'NOTICE'), 'Upstream attribution must survive');
  const artifact = generate(modules).find(value => value.fileName === 'THIRD_PARTY_NOTICES.txt');
  assert.match(artifact.source, /Verified upstream permission text/);
  assert.match(artifact.source, /Upstream attribution must survive/);
});
