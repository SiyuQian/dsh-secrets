import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { act, create } from 'react-test-renderer';

const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
const ENTRY = {
  name: 'SERVICE_ACCOUNT_API_TOKEN_WITH_A_LONG_VARIABLE_NAME',
  path: '/Users/example/Works/github.com/team/a-project-with-a-long-name/config/production/.env.local',
  fingerprint: 'sha256:abcd1234',
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
  tooShort: true,
};

// The shipped Client runs with real React. Cordis services, Chat projections,
// browser confirmation and selected timers use contract-shaped test doubles;
// these component tests do not verify browser geometry or live integration.
function client({ entries = [ENTRY], confirm = () => true, reply, timers = { setTimeout, clearTimeout } } = {}) {
  const registrations = [];
  const calls = [];
  let plugin;
  let dictionaries;
  const t = (key) => dictionaries.en[key] ?? key;
  const ctx = {
    effect: (callback) => callback(),
    locale: {
      register(_namespace, value) { dictionaries = value; return () => {}; },
      bind: () => t,
    },
    slots: {
      inject: (_owner, callback) => callback(),
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    get(name) {
      assert.equal(name, 'connection');
      return { rpc: { async call(path, method, payload) {
        assert.equal(path, '/api');
        calls.push({ method, payload });
        const value = reply ? await reply(method, payload) : { entries, pending: 0, dataDir: '/test' };
        return { ok: true, value };
      } } };
    },
  };
  runInNewContext(source, {
    window: { confirm, __ModuleLoader__: { load(module) {
      plugin = module.factory((name) => {
        assert.equal(name, 'react');
        return React;
      });
    } } },
    ...timers,
  });
  plugin.apply(ctx);
  const view = (slot) => registrations.find(({ options }) => options.name === slot);
  return { registrations, calls, t, view };
}

async function mount(t, component, props, options) {
  let renderer;
  await act(async () => { renderer = create(React.createElement(component, props), options); });
  t.after(() => act(() => renderer.unmount()));
  return renderer;
}

function text(node) {
  if (typeof node === 'string') return node;
  return node.children.map(text).join('');
}

function button(root, label) {
  return root.findAllByType('button').find((node) => text(node) === label);
}

function observable(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) { value = next; for (const listener of listeners) listener(); },
    get subscribers() { return listeners.size; },
  };
}

// Matches ChatNodeStore's documented per-Turn, per-kind source. Collapsing
// transcript groups does not remove their projected tool data.
function chatProjection(initialCalls = []) {
  const sources = new Map([[1, observable(initialCalls)]]);
  const nodes = { turnDataSource(turn, kind) {
    assert.equal(kind, 'tool-call');
    if (!sources.has(turn)) sources.set(turn, observable([]));
    return sources.get(turn);
  } };
  const state = observable({ timeline: { turnOrder: [1], turns: new Map([[1, { status: 'open' }]]) }, nodes });
  return {
    useChat(selector) {
      return selector(React.useSyncExternalStore(state.subscribe, state.getSnapshot));
    },
    source: (turn = 1) => nodes.turnDataSource(turn, 'tool-call'),
    selectTurn(turn, status = 'open') {
      state.set({ timeline: { turnOrder: turn === undefined ? [] : [turn], turns: new Map([[turn, { status }]]) }, nodes });
    },
  };
}

function pendingCall(callId = 'secret-1', phase = 'start') {
  return { root: {
    phase,
    callId,
    name: 'request_secret',
    argsRaw: JSON.stringify({ names: ['API_TOKEN'], purpose: 'Connect the service', env_file: '.env.local' }),
  } };
}

function pendingReply(method) {
  assert.equal(method, 'dsh-secrets.describe');
  return {
    open: true,
    purpose: 'Connect the service',
    path: '/test/.env.local',
    fields: [{ name: 'API_TOKEN', description: null, exists: false }],
    expiresAt: Date.now() + 60000,
  };
}

function dockView(app) {
  const registration = app.view('conversation.input.dock');
  assert.ok(registration, 'pending credentials must render outside collapsible transcript groups');
  return registration.component;
}

test('pending credentials are editable above the composer without mounting any transcript tool row', async (t) => {
  const app = client({ reply: pendingReply });
  const chat = chatProjection([pendingCall()]);
  let focused = 0;
  const renderer = await mount(t, dockView(app), { sessionId: 'session-1', useChat: chat.useChat, t: app.t }, {
    createNodeMock: (element) => element.type === 'input' ? { focus() { focused += 1; } } : null,
  });
  assert.equal(renderer.root.findByType('input').props.type, 'password');
  assert.equal(renderer.root.findByType('input').props.disabled, false);
  assert.equal(focused, 1);
  assert.equal(renderer.root.findAllByType('details').length, 0);
});

test('only the dock owns editable inputs while a tool row shows the pending summary', async (t) => {
  const app = client({ reply: pendingReply });
  const call = pendingCall().root;
  const renderer = await mount(t, app.view('tool.call.toolview').component, {
    phase: 'start', callId: call.callId, block: call, t: app.t,
  });
  assert.equal(renderer.root.findAllByType('input').length, 0);
  assert.ok(text(renderer.root).includes('above the chat input'));
  assert.equal(app.calls.length, 0, 'summary rows must not load a second form');
});

test('pending tool summaries tolerate malformed variable lists without crashing', async (t) => {
  const app = client();
  const call = { ...pendingCall().root, argsRaw: JSON.stringify({ names: 'API_TOKEN' }) };
  const renderer = await mount(t, app.view('tool.call.toolview').component, {
    phase: 'start', callId: call.callId, block: call, t: app.t,
  });
  assert.ok(text(renderer.root).includes('Credential request'));
  assert.ok(text(renderer.root).includes('above the chat input'));
  assert.equal(renderer.root.findAllByType('input').length, 0);
});

test('the dock observes pending calls added after mount and removes inputs when they settle', async (t) => {
  const app = client({ reply: pendingReply });
  const chat = chatProjection();
  const renderer = await mount(t, dockView(app), { sessionId: 'session-1', useChat: chat.useChat, t: app.t });
  assert.equal(renderer.toJSON(), null);
  await act(async () => { chat.source().set([pendingCall()]); });
  assert.equal(renderer.root.findAllByType('input').length, 1);
  await act(async () => { chat.source().set([{ root: { kind: 'tool-result', phase: 'result', callId: 'secret-1', name: 'request_secret' } }]); });
  assert.equal(renderer.toJSON(), null);
});

test('the dock ignores preparing and unrelated calls and handles a blank session', async (t) => {
  const app = client({ reply: pendingReply });
  const chat = chatProjection([pendingCall('preparing', 'preparing'), { root: { phase: 'start', name: 'bash', callId: 'shell' } }]);
  const renderer = await mount(t, dockView(app), { sessionId: 'session-1', useChat: chat.useChat, t: app.t });
  assert.equal(renderer.toJSON(), null);
  await act(async () => { chat.selectTurn(undefined); });
  assert.equal(renderer.toJSON(), null);
  assert.equal(chat.source().subscribers, 0, 'switching Turns must release the old source');
  assert.equal(app.calls.length, 0);
});

test('switching the active call clears typed credentials and observes only the new Turn', async (t) => {
  const app = client({ reply: pendingReply });
  const chat = chatProjection([pendingCall()]);
  const renderer = await mount(t, dockView(app), { sessionId: 'session-1', useChat: chat.useChat, t: app.t });
  await act(async () => { renderer.root.findByType('input').props.onChange({ target: { value: 'test-only-credential' } }); });
  assert.equal(renderer.root.findByType('input').props.value, 'test-only-credential');
  await act(async () => {
    chat.source(2).set([pendingCall('secret-2')]);
    chat.selectTurn(2);
  });
  assert.equal(renderer.root.findByType('input').props.value, '');
  assert.equal(chat.source(1).subscribers, 0);
  assert.equal(chat.source(2).subscribers, 1);
});

test('submitting uses the private RPC and immediately removes the editable form', async (t) => {
  const app = client({ reply: (method) => method === 'dsh-secrets.describe' ? pendingReply(method) : { ok: true } });
  const chat = chatProjection([pendingCall()]);
  const renderer = await mount(t, dockView(app), { sessionId: 'session-1', useChat: chat.useChat, t: app.t });
  await act(async () => { renderer.root.findByType('input').props.onChange({ target: { value: 'test-only-credential' } }); });
  await act(async () => { await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  const submitted = app.calls.find(({ method }) => method === 'dsh-secrets.submit');
  assert.deepEqual(JSON.parse(JSON.stringify(submitted?.payload)), { callId: 'secret-1', values: { API_TOKEN: 'test-only-credential' } });
  assert.equal(renderer.root.findAllByType('input').length, 0);
  assert.equal(text(renderer.root), '', 'a completed form must not revert to a waiting-for-input notice');
});

test('cancelling clears the form immediately even before the result reaches Chat', async (t) => {
  const app = client({ reply: (method) => method === 'dsh-secrets.describe' ? pendingReply(method) : { ok: true } });
  const chat = chatProjection([pendingCall()]);
  const renderer = await mount(t, dockView(app), { sessionId: 'session-1', useChat: chat.useChat, t: app.t });
  await act(async () => { renderer.root.findByType('input').props.onChange({ target: { value: 'test-only-credential' } }); });
  await act(async () => { await button(renderer.root, 'Cancel').props.onClick(); });
  assert.equal(app.calls.filter(({ method }) => method === 'dsh-secrets.cancel').length, 1);
  assert.equal(renderer.root.findAllByType('input').length, 0);
});

test('closed Turns never revive old requests and multiple live requests advance in order', async (t) => {
  const app = client({ reply: pendingReply });
  const chat = chatProjection([pendingCall('first'), pendingCall('second')]);
  chat.selectTurn(1, 'closed');
  const renderer = await mount(t, dockView(app), { sessionId: 'session-1', useChat: chat.useChat, t: app.t });
  assert.equal(renderer.toJSON(), null);
  assert.equal(app.calls.length, 0);
  await act(async () => { chat.selectTurn(1); });
  assert.equal(renderer.root.findByType('form').props['data-dsh-secrets-form'], 'first');
  await act(async () => { chat.source().set([pendingCall('second')]); });
  assert.equal(renderer.root.findByType('form').props['data-dsh-secrets-form'], 'second');
});

test('a new session cannot reuse typed values even if its pending call has the same identity', async (t) => {
  const app = client({ reply: pendingReply });
  const chat = chatProjection([pendingCall()]);
  const component = dockView(app);
  const renderer = await mount(t, component, { sessionId: 'session-1', useChat: chat.useChat, t: app.t });
  await act(async () => { renderer.root.findByType('input').props.onChange({ target: { value: 'test-only-credential' } }); });
  await act(async () => { renderer.update(React.createElement(component, { sessionId: 'session-2', useChat: chat.useChat, t: app.t })); });
  assert.equal(renderer.root.findByType('input').props.value, '');
});

test('the dock waits for Host registration and cancels retries when the call ends', async (t) => {
  const scheduled = new Map();
  const timers = {
    setTimeout(callback) { scheduled.set(callback, callback); return callback; },
    clearTimeout(id) { scheduled.delete(id); },
  };
  let ready = false;
  const app = client({ timers, reply: (method) => ready ? pendingReply(method) : { open: false } });
  const chat = chatProjection([pendingCall()]);
  const renderer = await mount(t, dockView(app), { sessionId: 'session-1', useChat: chat.useChat, t: app.t });
  assert.equal(renderer.root.findAllByType('input').length, 0, 'transcript arguments alone must not authorize an input form');
  assert.equal(scheduled.size, 1);
  ready = true;
  const retry = scheduled.values().next().value;
  scheduled.delete(retry);
  await act(async () => { await retry(); });
  assert.equal(renderer.root.findAllByType('input').length, 1);
  ready = false;
  await act(async () => { chat.source().set([pendingCall('not-yet-registered')]); });
  assert.equal(scheduled.size, 1);
  await act(async () => { chat.source().set([]); });
  assert.equal(scheduled.size, 0);
});

test('late describe responses cannot resurrect an ended request', async (t) => {
  let resolveDescribe;
  const response = new Promise((resolve) => { resolveDescribe = resolve; });
  const app = client({ reply: () => response });
  const chat = chatProjection([pendingCall()]);
  const renderer = await mount(t, dockView(app), { sessionId: 'session-1', useChat: chat.useChat, t: app.t });
  await act(async () => { chat.source().set([]); });
  await act(async () => { resolveDescribe(pendingReply('dsh-secrets.describe')); });
  assert.equal(renderer.toJSON(), null);
});

test('settings groups every credential with its complete metadata and actions', async (t) => {
  const app = client();
  const { component } = app.view('settings.section');
  const renderer = await mount(t, component, { t: app.t });
  const cards = renderer.root.findAllByType('article');
  assert.equal(cards.length, 1, 'each managed credential must have a self-contained card');
  const card = cards[0];
  assert.equal(card.findByType('h3').children.join(''), ENTRY.name);
  assert.ok(text(card).includes(ENTRY.path), 'the full path must not be shortened or hidden');
  assert.ok(text(card).includes(ENTRY.fingerprint));
  assert.equal(card.findByType('time').props.dateTime, ENTRY.updatedAt);
  assert.ok(text(card).includes('too short to hide in output'));
  assert.ok(button(card, 'Stop managing'));
  assert.ok(button(card, 'Delete from file'));
});

test('stop managing targets only the selected credential without deleting its file value', async (t) => {
  const other = { ...ENTRY, path: '/other/.env', fingerprint: 'sha256:87654321' };
  const app = client({ entries: [ENTRY, other] });
  const renderer = await mount(t, app.view('settings.section').component, { t: app.t });
  const cards = renderer.root.findAllByType('article');
  assert.equal(cards.length, 2);
  await act(async () => { await button(cards[1], 'Stop managing').props.onClick(); });
  const remove = app.calls.find(({ method }) => method === 'dsh-secrets.remove');
  assert.deepEqual(JSON.parse(JSON.stringify(remove?.payload)), {
    path: '/other/.env', name: ENTRY.name, deleteFromFile: false,
  });
});

test('deleting a credential requires confirmation and preserves metadata when declined', async (t) => {
  const app = client({ confirm: () => false });
  const renderer = await mount(t, app.view('settings.section').component, { t: app.t });
  await act(async () => { await button(renderer.root, 'Delete from file').props.onClick(); });
  assert.equal(app.calls.filter(({ method }) => method === 'dsh-secrets.remove').length, 0);
  assert.ok(text(renderer.root).includes(ENTRY.path));
});

test('settings shows the empty state without credential actions', async (t) => {
  const app = client({ entries: [] });
  const renderer = await mount(t, app.view('settings.section').component, { t: app.t });
  assert.ok(text(renderer.root).includes('No protected credentials yet.'));
  assert.equal(button(renderer.root, 'Delete from file'), undefined);
});
