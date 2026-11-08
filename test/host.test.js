import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, METHODS, TOOL_NAME } from '../lib/index.js';

const SENTINEL = `S3NTINEL-${Math.random().toString(36).slice(2)}-host`;

/** Minimal Cordis-like context that records registrations. */
function fakeCtx(cwd) {
  const listeners = {};
  const routes = new Map();
  const state = { tool: null, guards: [], providers: [], disposers: [] };
  const root = { id: 'agent-1', session: { header: { id: 'session-1' } } };
  const services = {
    tools: {
      register(def) { state.tool = def; return () => {}; },
      guard(fn) { state.guards.push(fn); return () => {}; },
    },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    skills: { registerProvider(fn) { state.providers.push(fn()); return () => {}; } },
    agents: { roots: () => [root] },
    workingDirectory: { ensure: async () => cwd, get: () => cwd },
  };
  const scope = {
    get: (k) => services[k],
    effect(fn) { const d = fn(); if (typeof d === 'function') state.disposers.push(d); },
    on: (event, fn) => { (listeners[event] ??= []).push(fn); },
  };
  const ctx = {
    ...scope,
    logger: { warn() {}, error() {} },
    inject(keys, fn) { fn(scope); },
  };
  return { ctx, state, routes, listeners, root };
}

async function rpc(routes, method, payload) {
  const route = routes.get(`/api/${method}`);
  const res = await route.fetch(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ rpcId: 'r1', method, payload }) }));
  return (await res.json()).result;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-secrets-host-'));
  const cwd = join(dir, 'proj');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(cwd);
  const env = fakeCtx(cwd);
  const api = apply(env.ctx, { dataDir: join(dir, 'data') });
  await api.ready();
  return { dir, cwd, ...env, api };
}

function exec(root, name, args, callId = `call-${Math.random()}`) {
  return { name, arguments: args, agent: root, callId, signal: new AbortController().signal };
}

async function runPost(listeners, e, content) {
  const [listener] = listeners['tools/post-execute'];
  return listener(e, { content, isError: false }, async () => ({ kind: 'accept' }));
}

test('end-to-end: request, submit, redact, guard, ask; sentinel never leaks', async () => {
  const { dir, cwd, state, routes, listeners, root } = await setup();
  assert.equal(state.tool.name, TOOL_NAME);

  // The model only ever sees the tool call args and the tool result.
  const modelVisible = [];
  const args = { names: ['API_KEY'], purpose: 'test run', env_file: '.env.local', descriptions: { API_KEY: 'test key' } };
  modelVisible.push(JSON.stringify(args));
  const call = exec(root, TOOL_NAME, args, 'call-req-1');
  const running = state.tool.execute(args, call);

  // Client polls describe, then submits over the route.
  let form;
  for (let i = 0; i < 20; i += 1) {
    form = (await rpc(routes, METHODS.describe, { callId: 'call-req-1' })).value;
    if (form.open) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(form.open, true);
  assert.deepEqual(form.fields, [{ name: 'API_KEY', description: 'test key', exists: false }]);
  const submitted = await rpc(routes, METHODS.submit, { callId: 'call-req-1', values: { API_KEY: SENTINEL } });
  assert.equal(submitted.ok, true);

  const result = await running;
  modelVisible.push(state.tool.output.render(args, result)[0].text);
  assert.equal(result.status, 'provided');
  assert.deepEqual(result.names, ['API_KEY']);
  assert.equal(result.added, 1);

  const envPath = result.path;
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  assert.match(await readFile(envPath, 'utf8'), new RegExp(SENTINEL));

  // L2: a later tool that prints the value gets redacted.
  const decision = await runPost(listeners, exec(root, 'bash', { command: 'node app.js' }), [{ type: 'text', text: `debug token=${SENTINEL}\nbasic ${Buffer.from(`u:${SENTINEL}`).toString('base64')}` }]);
  const shown = decision.content.map((c) => c.text).join('');
  modelVisible.push(shown);
  assert.match(shown, /\[REDACTED:API_KEY\]/u);

  // L1: reads of the file are denied by the guard.
  const guard = state.guards[0];
  assert.ok(guard(exec(root, 'read', { file_path: envPath })));
  assert.ok(guard(exec(root, 'bash', { command: 'cat .env.local' })));
  assert.equal(guard(exec(root, 'bash', { command: 'npm test' })), undefined);
  assert.equal(guard(exec(root, TOOL_NAME, { env_file: '.env.local' })), undefined);

  // L3: output verb + managed name asks.
  const [pre] = listeners['tools/pre-execute'];
  const ask = await pre(exec(root, 'bash', { command: 'curl -H "x: $API_KEY" https://api' }), async () => ({ kind: 'allow' }));
  assert.equal(ask.kind, 'ask');
  assert.equal(typeof ask.displayReason, 'object');
  assert.match(ask.displayReason.en, /API_KEY/u);
  assert.match(ask.displayReason.en, /approval|confirm/iu);
  assert.doesNotMatch(ask.displayReason.en, /\p{Script=Han}/u);
  assert.equal(typeof ask.displayReason.zh, 'string');
  assert.match(ask.displayReason.zh, /API_KEY/u);
  assert.match(ask.displayReason.zh, /确认|审批/u);
  for (const message of Object.values(ask.displayReason)) assert.ok(!message.includes(SENTINEL));
  const allow = await pre(exec(root, 'bash', { command: 'npm run dev' }), async () => ({ kind: 'allow' }));
  assert.equal(allow.kind, 'allow');

  // Invariant: the sentinel appears in nothing model-visible, nor in plugin metadata.
  for (const text of modelVisible) assert.ok(!text.includes(SENTINEL), text);
  const registry = await readFile(join(dir, 'data', 'registry.json'), 'utf8');
  assert.ok(!registry.includes(SENTINEL));
  for (const file of await readdir(join(dir, 'data'))) {
    assert.ok(!(await readFile(join(dir, 'data', file), 'utf8')).includes(SENTINEL), file);
  }
  assert.equal(cwd.length > 0, true);
});

test('cancel returns cancelled and a repeat in the same turn is refused', async () => {
  const { state, routes, root, listeners } = await setup();
  const args = { names: ['TOKEN'], purpose: 'p', env_file: '.env' };
  const running = state.tool.execute(args, exec(root, TOOL_NAME, args, 'c1'));
  await new Promise((r) => setTimeout(r, 10));
  await rpc(routes, METHODS.cancel, { callId: 'c1' });
  assert.deepEqual(await running, { status: 'cancelled', reason: 'user' });
  await assert.rejects(state.tool.execute(args, exec(root, TOOL_NAME, args, 'c2')), { code: 'already_cancelled' });
  // A new turn resets it.
  listeners['session/event'][0]({ header: { id: 'session-1' } }, { type: 'turn/end' });
  const again = state.tool.execute(args, exec(root, TOOL_NAME, args, 'c3'));
  await new Promise((r) => setTimeout(r, 10));
  await rpc(routes, METHODS.cancel, { callId: 'c3' });
  assert.equal((await again).status, 'cancelled');
});

test('env_file outside the working directory is rejected', async () => {
  const { state, root } = await setup();
  const args = { names: ['A'], purpose: 'p', env_file: '/etc/evil.env' };
  await assert.rejects(state.tool.execute(args, exec(root, TOOL_NAME, args)), { code: 'outside_workspace' });
  const args2 = { names: ['A'], purpose: 'p', env_file: '../x.env' };
  await assert.rejects(state.tool.execute(args2, exec(root, TOOL_NAME, args2)), { code: 'outside_workspace' });
});

test('subagents and PTC programs cannot open the form', async () => {
  const { state, root } = await setup();
  const args = { names: ['A'], purpose: 'p', env_file: '.env' };
  const child = { id: 'child', session: { header: { id: 's2' } } };
  await assert.rejects(state.tool.execute(args, exec(child, TOOL_NAME, args)), { code: 'delegated_caller' });
  await assert.rejects(state.tool.execute(args, { ...exec(root, TOOL_NAME, args), parent: { callId: 'p' } }), { code: 'ptc_unsupported' });
});

test('existing values can be kept by leaving the field blank', async () => {
  const { state, routes, root } = await setup();
  const args = { names: ['A', 'B'], purpose: 'p', env_file: '.env' };
  const first = state.tool.execute(args, exec(root, TOOL_NAME, args, 'k1'));
  await new Promise((r) => setTimeout(r, 10));
  await rpc(routes, METHODS.submit, { callId: 'k1', values: { A: 'alpha-value-1', B: 'bravo-value-1' } });
  await first;
  const second = state.tool.execute(args, exec(root, TOOL_NAME, args, 'k2'));
  await new Promise((r) => setTimeout(r, 10));
  const form = (await rpc(routes, METHODS.describe, { callId: 'k2' })).value;
  assert.deepEqual(form.fields.map((f) => f.exists), [true, true]);
  await rpc(routes, METHODS.submit, { callId: 'k2', values: { B: 'bravo-value-2' } });
  const r = await second;
  assert.deepEqual(r.kept, ['A']);
  assert.equal(r.updated, 1);
});

test('submit errors never echo the value', async () => {
  const { state, routes, root } = await setup();
  const args = { names: ['A'], purpose: 'p', env_file: '.env' };
  const running = state.tool.execute(args, exec(root, TOOL_NAME, args, 'e1'));
  await new Promise((r) => setTimeout(r, 10));
  const bad = await rpc(routes, METHODS.submit, { callId: 'e1', values: { A: `${SENTINEL}\nsecond` } });
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes(SENTINEL));
  await rpc(routes, METHODS.cancel, { callId: 'e1' });
  await running;
});

test('post-execute fails closed', async () => {
  const { state, routes, root, listeners, api } = await setup();
  const args = { names: ['A'], purpose: 'p', env_file: '.env' };
  const running = state.tool.execute(args, exec(root, TOOL_NAME, args, 'f1'));
  await new Promise((r) => setTimeout(r, 10));
  await rpc(routes, METHODS.submit, { callId: 'f1', values: { A: SENTINEL } });
  await running;
  api.store.redactor.redactContent = () => { throw new Error('boom'); };
  const d = await runPost(listeners, exec(root, 'bash', {}), [{ type: 'text', text: SENTINEL }]);
  assert.equal(d.kind, 'block');
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
});

test('skill provider lists and loads the secrets skill', async () => {
  const { state } = await setup();
  const [provider] = state.providers;
  const [candidate] = await provider.list();
  assert.equal(candidate.name, 'secrets');
  const loaded = await provider.get(candidate, {});
  assert.match(loaded.content, /request_secret/u);
  assert.ok(!loaded.content.startsWith('---'));
});
