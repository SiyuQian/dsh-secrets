import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('the browser can resolve the Client factory under the scoped npm package name', async () => {
  const modules = new Map();
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(module) { modules.set(module.id, module.factory); } } },
  });
  assert.equal(typeof modules.get('@siyuqian/dsh-secrets'), 'function');
});
