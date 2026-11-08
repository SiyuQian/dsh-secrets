import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SecretStore } from '../lib/store.js';

const SENTINEL = 'S3NTINEL-store-7c1f9a';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secrets-'));
  const store = new SecretStore({ dataDir: join(root, 'data') });
  await store.load();
  const env = await store.resolvePath(join(root, 'app', '.env.local'));
  return { root, store, env };
}

test('write creates a 0600 dotenv, registry holds no value', async () => {
  const { root, store, env } = await setup();
  const r = await store.write(env, { API_KEY: SENTINEL });
  assert.deepEqual(r, { added: 1, updated: 0, unchanged: 0 });
  assert.equal((await stat(env)).mode & 0o777, 0o600);
  assert.equal(await readFile(env, 'utf8'), `API_KEY='${SENTINEL}'\n`);
  const registry = await readFile(join(root, 'data', 'registry.json'), 'utf8');
  assert.ok(!registry.includes(SENTINEL));
  assert.ok(!registry.includes('store-7c1f9a'));
  assert.match(registry, /"API_KEY"/u);
  assert.equal(((await stat(join(root, 'data', 'registry.json'))).mode & 0o777), 0o600);
});

test('redactor survives a restart via the dotenv file', async () => {
  const { root, store, env } = await setup();
  await store.write(env, { API_KEY: SENTINEL });
  const again = new SecretStore({ dataDir: join(root, 'data') });
  await again.load();
  assert.equal(again.redactor.redact(`x ${SENTINEL}`).text, 'x [REDACTED:API_KEY]');
  assert.ok(again.protectedPaths().has(env));
});

test('preserves unrelated content and updates existing', async () => {
  const { store, env } = await setup();
  await store.write(env, { A: 'aaaaaa1' });
  await writeFile(env, `# keep\n${await readFile(env, 'utf8')}OTHER=1\n`);
  const r = await store.write(env, { A: 'bbbbbb2', B: 'cccccc3' });
  assert.deepEqual(r, { added: 1, updated: 1, unchanged: 0 });
  assert.equal(await readFile(env, 'utf8'), "# keep\nA='bbbbbb2'\nOTHER=1\nB='cccccc3'\n");
  assert.equal(store.redactor.redact('aaaaaa1').text, 'aaaaaa1', 'old value no longer tracked');
});

test('remove with deleteFromFile drops the line and the redaction', async () => {
  const { store, env } = await setup();
  await store.write(env, { A: SENTINEL, B: 'keepme12' });
  await store.remove(env, 'A', { deleteFromFile: true });
  assert.equal(await readFile(env, 'utf8'), "B='keepme12'\n");
  assert.equal(store.redactor.redact(SENTINEL).text, SENTINEL);
  assert.deepEqual(store.list().map((e) => e.name), ['B']);
});

test('adopt tracks existing values without rewriting', async () => {
  const { store, env } = await setup();
  await store.write(env, { A: 'first-value' });
  await store.remove(env, 'A');
  assert.equal(store.list().length, 0);
  await store.adopt(env, ['A']);
  assert.equal(store.list()[0].name, 'A');
  assert.match(store.redactor.redact('first-value').text, /REDACTED:A/u);
});

test('short values are stored but flagged', async () => {
  const { store, env } = await setup();
  await store.write(env, { PIN: '1234' });
  assert.equal(store.list()[0].tooShort, true);
});
