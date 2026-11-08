// dsh-secrets Host half.
//
// request_secret blocks until the user submits a form rendered by the Client
// toolview. Values travel only over the authenticated `/api/dsh-secrets.*`
// fetch routes (no session event, no tool argument, no tool result), land in a
// 0600 dotenv file, and feed the in-memory redactor.
//
// Defences beyond "the skill says don't": L1 guard (deny reads of managed
// files), L2 post-execute redaction on every tool result, L3 pre-execute ask
// when a shell command combines a managed variable with an output verb.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DotenvError, NAME_PATTERN, validateValue } from './dotenv.js';
import { exfilNames, readDenial } from './policy.js';
import { SecretStore } from './store.js';

export const name = 'dsh-secrets';
export const TOOL_NAME = 'request_secret';
export const METHODS = {
  describe: 'dsh-secrets.describe',
  submit: 'dsh-secrets.submit',
  cancel: 'dsh-secrets.cancel',
  list: 'dsh-secrets.list',
  remove: 'dsh-secrets.remove',
};
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SKILL_DIR = fileURLToPath(new URL('../skills/secrets/', import.meta.url));

const TOOL_DESCRIPTION = [
  'Ask the user to type credentials (API keys, passwords, tokens) into a secure form. The values are written to a dotenv file with mode 0600 and are never shown to you.',
  'Call it whenever a task needs a credential; never ask the user to paste one into chat.',
  'Request every currently known variable in one call. The call blocks until the user saves or cancels the form.',
  'The result contains only the file path, variable names and counts. Do not read, print, grep, copy or verify the file afterwards: the dsh-secrets policy denies those calls. Let the program load the file itself (for example with dotenv).',
  'If the user cancels, do not request the same variables again in this turn.',
].join(' ');

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['names', 'purpose', 'env_file'],
  properties: {
    names: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string' },
      description: 'Environment variable names to request, e.g. ["OPENAI_API_KEY"]. Letters, digits and underscores; must not start with a digit.',
    },
    purpose: { type: 'string', description: 'One line telling the user why these credentials are needed.' },
    descriptions: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Optional short plain-language description per variable name.',
    },
    env_file: {
      type: 'string',
      description: 'Dotenv file to write, relative to the working directory (e.g. ".env.local") or absolute inside it.',
    },
  },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['provided', 'cancelled'] },
    reason: { type: 'string' },
    path: { type: 'string' },
    names: { type: 'array', items: { type: 'string' } },
    added: { type: 'integer' },
    updated: { type: 'integer' },
    unchanged: { type: 'integer' },
    kept: { type: 'array', items: { type: 'string' } },
  },
};

function toolError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rpcError(rpcId, code, message) {
  return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code, message, details: { issues: [] } } } });
}

/** One exact `/api/<method>` POST route using the Harness RPC envelope. */
function payloadRoute(method, handler) {
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request';
      if (body?.method !== method) return rpcError(rpcId, 'gateway/bad-request', 'unexpected method');
      try {
        const value = await handler(body?.payload ?? {});
        return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
      } catch (error) {
        // Handler errors are written to never contain values.
        return rpcError(rpcId, error?.code ?? 'dsh-secrets/error', error?.message ?? String(error));
      }
    },
  };
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

export function parseRequest(args) {
  const names = Array.isArray(args?.names) ? args.names.map((n) => String(n).trim()) : [];
  if (names.length === 0) throw toolError('names must list at least one variable', 'invalid_names');
  for (const n of names) if (!NAME_PATTERN.test(n)) throw toolError(`invalid variable name ${JSON.stringify(n)}: use letters, digits and underscores, not starting with a digit`, 'invalid_names');
  if (new Set(names).size !== names.length) throw toolError('variable names must be unique', 'invalid_names');
  const purpose = typeof args?.purpose === 'string' ? args.purpose.trim() : '';
  if (purpose.length === 0) throw toolError('purpose is required', 'invalid_purpose');
  const envFile = typeof args?.env_file === 'string' ? args.env_file.trim() : '';
  if (envFile.length === 0) throw toolError('env_file is required', 'invalid_env_file');
  const descriptions = {};
  for (const [key, value] of Object.entries(args?.descriptions ?? {})) {
    if (!names.includes(key)) throw toolError(`descriptions names an unrequested variable ${key}`, 'invalid_descriptions');
    if (typeof value === 'string' && value.trim()) descriptions[key] = value.trim().slice(0, 200);
  }
  return { names, purpose: purpose.slice(0, 300), envFile, descriptions };
}

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugins', 'dsh-secrets');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowOutsideCwd = config.allowOutsideCwd === true;
  const log = ctx.logger ?? console;
  const store = new SecretStore({ dataDir, warn: (m) => log.warn?.(m) });
  let ready = store.load().catch((error) => {
    log.error?.(`dsh-secrets: failed to load registry: ${error?.message ?? error}`);
    throw error;
  });

  /** callId -> pending form */
  const pending = new Map();
  /** sessionId -> Set of names cancelled in the current turn */
  const cancelledThisTurn = new Map();
  /** sessionId -> Set of names the user approved for L3 in this session */
  const approvedExfil = new Map();

  // ---------------------------------------------------------------- tool
  ctx.inject(['tools'], (scope) => {
    const tools = scope.get('tools');
    scope.effect(() => tools.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        await ready;
        const request = parseRequest(args);
        const agent = exec.agent;
        if (agent === undefined) throw toolError('request_secret needs a live session', 'no_agent');
        if (exec.parent !== undefined) throw toolError('request_secret is not available inside run_code programs; call it directly', 'ptc_unsupported');
        const agents = scope.get('agents');
        if (agents?.roots && !agents.roots().includes(agent)) {
          throw toolError('request_secret is only available to the top-level agent; report the needed variables in your final result instead', 'delegated_caller');
        }
        const sessionId = agent.session?.header?.id ?? agent.session?.id ?? 'unknown';
        const cancelled = cancelledThisTurn.get(sessionId);
        const repeat = request.names.filter((n) => cancelled?.has(n));
        if (repeat.length > 0) throw toolError(`the user already cancelled a request for ${repeat.join(', ')} in this turn; do not ask again, continue without it or ask the user how to proceed`, 'already_cancelled');

        const wd = scope.get('workingDirectory');
        const cwd = wd && agent ? await wd.ensure(agent, exec.signal) : process.cwd();
        const target = await store.resolvePath(isAbsolute(request.envFile) ? request.envFile : resolve(cwd, request.envFile));
        const root = await store.resolvePath(cwd);
        if (!allowOutsideCwd && !inside(root, target)) {
          throw toolError(`env_file must be inside the working directory ${root}`, 'outside_workspace');
        }
        const existing = await store.existing(target, request.names);

        const callId = exec.callId;
        const settled = await new Promise((resolvePromise, rejectPromise) => {
          const timer = setTimeout(() => finish({ status: 'cancelled', reason: 'timeout' }), timeoutMs);
          timer.unref?.();
          const onAbort = () => finish(null, toolError('request_secret was aborted before the user answered', 'aborted'));
          exec.signal.addEventListener('abort', onAbort, { once: true });
          function finish(value, error) {
            if (!pending.has(callId)) return;
            pending.delete(callId);
            clearTimeout(timer);
            exec.signal.removeEventListener('abort', onAbort);
            if (error) rejectPromise(error); else resolvePromise(value);
          }
          pending.set(callId, { request, path: target, existing, sessionId, finish, createdAt: Date.now() });
          if (exec.signal.aborted) onAbort();
        });
        if (settled.status === 'cancelled') {
          if (!cancelledThisTurn.has(sessionId)) cancelledThisTurn.set(sessionId, new Set());
          for (const n of request.names) cancelledThisTurn.get(sessionId).add(n);
        }
        return settled;
      },
    }), `${name}: ${TOOL_NAME} tool`);

    // L1: monotonic guard. Synchronous, cannot be overridden by later allows.
    scope.effect(() => tools.guard((exec) => {
      if (exec.name === TOOL_NAME) return undefined;
      const protectedPaths = store.protectedPaths();
      if (protectedPaths.size === 0) return undefined;
      const cwd = cwdOf(scope, exec);
      return readDenial({ tool: exec.name, args: exec.arguments, cwd, protectedPaths });
    }), `${name}: read guard`);
  });

  function cwdOf(scope, exec) {
    const session = exec.agent?.session;
    if (session === undefined) return undefined;
    try {
      return scope.get('workingDirectory')?.get(session) ?? undefined;
    } catch {
      return undefined;
    }
  }

  // Reset per-turn cancellation memory when a turn ends.
  ctx.on?.('session/event', (session, event) => {
    if (event?.type === 'turn/end') cancelledThisTurn.delete(session?.header?.id ?? session?.id);
  });

  // L3: ask before a shell command pairs a managed variable with an output verb.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const names = store.names();
    if (names.size === 0) return next();
    const hits = exfilNames({ tool: exec.name, args: exec.arguments, names });
    if (hits.length === 0) return next();
    const sessionId = exec.agent?.session?.header?.id;
    const approved = approvedExfil.get(sessionId);
    if (approved && hits.every((h) => approved.has(h))) return next();
    const downstream = await next();
    if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream;
    const list = hits.join(', ');
    return {
      kind: 'ask',
      reason: `This command uses the managed secret ${list} together with a command that can print or send data. dsh-secrets requires the user's approval.`,
      displayReason: {
        en: `This command uses the managed secret ${list} and can print or send data. Your approval is required before it runs.`,
        zh: `此命令使用受管理的凭据 ${list}，并且可能输出或外发数据。执行前需要你确认。`,
      },
    };
  });

  // L2: redact every tool result. Runs after downstream (spill, etc.) decided,
  // and fails closed: an error while redacting blocks the result.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (store.redactor.size === 0) return decision;
    try {
      if (decision.kind === 'block') {
        const r = store.redactor.redactContent(decision.feedback);
        return r ? { ...decision, feedback: r.content } : decision;
      }
      const content = decision.content ?? result.content;
      const r = store.redactor.redactContent(content);
      if (r === undefined) return decision;
      const { value: _dropValue, ...rest } = decision;
      return {
        ...rest,
        kind: 'accept',
        content: [...r.content, { type: 'text', text: `\n[dsh-secrets: hid the value of ${r.hits.join(', ')} from this output]` }],
      };
    } catch (error) {
      log.error?.(`dsh-secrets: redaction failed for ${exec.name}: ${error?.message ?? error}`);
      return { kind: 'block', feedback: [{ type: 'text', text: 'dsh-secrets could not check this output for secrets, so it was withheld.' }] };
    }
  });

  // ------------------------------------------------------------ fetch routes
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection');
    const routes = [
      payloadRoute(METHODS.describe, async ({ callId }) => {
        await ready;
        const p = pending.get(String(callId ?? ''));
        if (!p) return { open: false };
        return {
          open: true,
          purpose: p.request.purpose,
          path: p.path,
          fields: p.request.names.map((n) => ({ name: n, description: p.request.descriptions[n] ?? null, exists: p.existing.includes(n) })),
          expiresAt: p.createdAt + timeoutMs,
        };
      }),
      payloadRoute(METHODS.submit, async ({ callId, values }) => {
        await ready;
        const p = pending.get(String(callId ?? ''));
        if (!p) throw toolError('this request is no longer waiting for input', 'not_pending');
        if (values === null || typeof values !== 'object' || Array.isArray(values)) throw toolError('values must be an object', 'bad_values');
        const submitted = {};
        const kept = [];
        for (const n of p.request.names) {
          const v = values[n];
          if (typeof v === 'string' && v.length > 0) {
            validateValue(n, v);
            submitted[n] = v;
          } else if (p.existing.includes(n)) {
            kept.push(n);
          } else {
            throw toolError(`${n} is required`, 'missing_value');
          }
        }
        for (const key of Object.keys(values)) if (!p.request.names.includes(key)) throw toolError(`unexpected variable ${key}`, 'bad_values');
        let counts = { added: 0, updated: 0, unchanged: 0 };
        try {
          if (Object.keys(submitted).length > 0) counts = await store.write(p.path, submitted);
          if (kept.length > 0) await store.adopt(p.path, kept);
        } catch (error) {
          if (error instanceof DotenvError) throw toolError(error.message, error.code);
          throw toolError('could not write the dotenv file', 'write_failed');
        }
        p.finish({ status: 'provided', path: p.path, names: p.request.names, ...counts, kept });
        return { ok: true, path: p.path, names: p.request.names, ...counts, kept };
      }),
      payloadRoute(METHODS.cancel, async ({ callId }) => {
        const p = pending.get(String(callId ?? ''));
        if (p) p.finish({ status: 'cancelled', reason: 'user' });
        return { ok: true };
      }),
      payloadRoute(METHODS.list, async () => {
        await ready;
        return { entries: store.list(), dataDir, pending: pending.size };
      }),
      payloadRoute(METHODS.remove, async ({ path, name: varName, deleteFromFile }) => {
        await ready;
        if (typeof path !== 'string' || typeof varName !== 'string') throw toolError('path and name are required', 'bad_args');
        if (!store.list().some((e) => e.path === path && e.name === varName)) throw toolError('not managed', 'not_found');
        await store.remove(path, varName, { deleteFromFile: deleteFromFile === true });
        return { ok: true };
      }),
    ];
    for (const route of routes) scope.effect(() => connection.fetch.register(route), `${name}: ${route.path}`);
  });

  // ----------------------------------------------------------------- skill
  ctx.inject(['skills'], (scope) => {
    const locator = join(SKILL_DIR, 'SKILL.md');
    const candidate = {
      name: 'secrets',
      description: 'Use when a task needs an API key, password, token, or connection string: request it securely with request_secret instead of asking the user to paste it.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: name,
      source: 'plugin',
      rank: 0,
      resourceBase: { kind: 'directory', path: SKILL_DIR.split(sep).join('/').replace(/\/$/u, '') },
      locator,
    };
    scope.effect(() => scope.get('skills').registerProvider(() => ({
      name,
      list: () => Promise.resolve([candidate]),
      async get(c, options) {
        const { rank: _rank, locator: file, ...summary } = c;
        const raw = await readFile(file, { encoding: 'utf8', signal: options?.signal });
        return { ...summary, content: raw.replace(/^---[\s\S]*?---\r?\n/u, '').trim() };
      },
    })), `${name}: skill provider`);
  });

  ctx.effect?.(() => () => {
    for (const p of pending.values()) p.finish(null, toolError('dsh-secrets was unloaded', 'unloaded'));
  }, `${name}: pending cleanup`);

  // Exposed for tests.
  return { store, pending, ready: () => ready, approveExfil: (sessionId, names) => {
    if (!approvedExfil.has(sessionId)) approvedExfil.set(sessionId, new Set());
    for (const n of names) approvedExfil.get(sessionId).add(n);
  } };
}
