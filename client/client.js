// dsh-secrets Client half: a secure form above the chat input, tool receipts,
// and a Settings page listing managed variables.
// Values go straight to the Host over /api/dsh-secrets.submit and are cleared
// from component state right after; nothing is persisted in the browser.
window.__ModuleLoader__.load({
  id: '@siyuqian/dsh-secrets',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } = React;

    const NS = 'dsh-secrets';
    const M = {
      describe: 'dsh-secrets.describe',
      submit: 'dsh-secrets.submit',
      cancel: 'dsh-secrets.cancel',
      list: 'dsh-secrets.list',
      remove: 'dsh-secrets.remove',
    };

    const zh = {
      title: '请求凭据',
      waiting: '请在聊天输入框上方填写凭据。',
      loading: '正在加载表单…',
      purpose: '用途',
      writesTo: '将写入',
      mode: '（仅你可读，0600）',
      note: '这些值不会发送给模型，也不会写入会话记录。',
      exists: '已存在，留空则保留原值',
      required: '必填',
      show: '显示',
      hide: '隐藏',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      expired: '这个请求已经结束（已提交、已取消或已超时）。',
      provided: '已提供',
      cancelled: '已取消',
      timeout: '已超时',
      failed: '失败',
      kept: '保留原值',
      section: 'Secrets',
      settingsTitle: '受保护的凭据',
      settingsIntro: '这些变量由 dsh-secrets 管理：值保存在下面列出的 dotenv 文件中（权限 0600），模型看不到值，读取这些文件的工具调用会被拒绝，工具输出中出现的值会被替换为 [REDACTED:名称]。',
      empty: '还没有受保护的凭据。Agent 需要凭据时会调用 request_secret，并在对话中弹出表单。',
      colName: '变量',
      colFile: '文件',
      colFp: '指纹',
      colUpdated: '更新时间',
      untrack: '停止管理',
      delete: '从文件删除',
      confirmDelete: '确定从文件中删除 {name}？这会删除该行，正在使用它的程序会失效。',
      tooShort: '太短，无法在输出中隐藏',
      limits: '已知限制：Agent 若自行编写程序读取文件并对值做任意变换后外发，这些防线无法完全拦截；请只在可信的工作区中使用。run_code（PTC）模式下不可用。',
      refresh: '刷新',
    };
    const en = {
      title: 'Credential request',
      waiting: 'Enter your credentials above the chat input.',
      loading: 'Loading form…',
      purpose: 'Purpose',
      writesTo: 'Will be written to',
      mode: ' (owner-only, 0600)',
      note: 'These values are never sent to the model or written to the session log.',
      exists: 'Already set; leave blank to keep it',
      required: 'Required',
      show: 'Show',
      hide: 'Hide',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      expired: 'This request has ended (submitted, cancelled, or timed out).',
      provided: 'Provided',
      cancelled: 'Cancelled',
      timeout: 'Timed out',
      failed: 'Failed',
      kept: 'kept',
      section: 'Secrets',
      settingsTitle: 'Protected credentials',
      settingsIntro: 'dsh-secrets manages these variables: values live in the dotenv files below (mode 0600), the model never sees them, tool calls that read the files are denied, and values that appear in tool output are replaced with [REDACTED:NAME].',
      empty: 'No protected credentials yet. When the agent needs one it calls request_secret and a form appears in the conversation.',
      colName: 'Variable',
      colFile: 'File',
      colFp: 'Fingerprint',
      colUpdated: 'Updated',
      untrack: 'Stop managing',
      delete: 'Delete from file',
      confirmDelete: 'Delete {name} from the file? The line is removed and programs using it will stop working.',
      tooShort: 'too short to hide in output',
      limits: 'Known limits: an agent that writes its own program to read the file and transform the value arbitrarily before sending it can evade these defences; use only in trusted workspaces. Not available in run_code (PTC) mode.',
      refresh: 'Refresh',
    };

    const STYLE = `
.dshs-dock{min-width:0;max-height:50vh;overflow-y:auto;overscroll-behavior:contain}
.dshs-card{box-sizing:border-box;min-width:0;max-width:100%;overflow-wrap:anywhere;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-warn-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1);margin:6px 0;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary)}
.dshs-head{display:flex;gap:10px;align-items:flex-start;padding:12px 14px}
.dshs-head>div{min-width:0}
.dshs-lock{flex:none;width:18px;height:18px;color:var(--dsw-alias-state-warn-primary);margin-top:1px}
.dshs-title{font-weight:600;font-size:14px}
.dshs-sub{color:var(--dsw-alias-label-secondary);margin-top:2px}
.dshs-body{padding:4px 14px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshs-field{margin-top:10px}
.dshs-label{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.dshs-desc{color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:12px}
.dshs-row{display:flex;gap:6px;margin-top:4px}
.dshs-input{flex:1;min-width:0;height:32px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;outline:none}
.dshs-input:focus{border-color:var(--dsw-alias-state-warn-primary)}
.dshs-btn{height:32px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;white-space:nowrap}
.dshs-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshs-btn:disabled{opacity:.5;cursor:default}
.dshs-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
.dshs-primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill))}
.dshs-danger{color:var(--dsw-alias-state-error-primary)}
.dshs-note{margin-top:10px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshs-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-bg-layer-2);padding:1px 6px;border-radius:4px;word-break:break-all}
.dshs-actions{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshs-error{color:var(--dsw-alias-state-error-primary);margin-top:8px}
.dshs-done{display:flex;gap:8px;align-items:center;padding:8px 12px;color:var(--dsw-alias-label-secondary)}
.dshs-done b{color:var(--dsw-alias-label-primary);font-weight:500}
.dshs-ok{color:var(--dsw-alias-state-success-primary)}
.dshs-page{box-sizing:border-box;width:100%;min-width:0;max-width:960px;padding:24px clamp(12px,4vw,28px);color:var(--dsw-alias-label-primary);font-size:13px;overflow-wrap:anywhere}
.dshs-page h2{font-size:18px;margin:0;min-width:0}
.dshs-page p{color:var(--dsw-alias-label-secondary);line-height:1.6}
.dshs-page-head{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center}
.dshs-entries{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;list-style:none;margin:16px 0 0;padding:0}
.dshs-entry{min-width:0;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dshs-entry h3{margin:0;font-size:13px;font-weight:600}
.dshs-details{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:12px;margin:14px 0}
.dshs-details>div{min-width:0}
.dshs-details .dshs-file{grid-column:1/-1}
.dshs-details dt{color:var(--dsw-alias-label-secondary);font-size:12px}
.dshs-details dd{margin:4px 0 0;overflow-wrap:anywhere}
.dshs-entry-actions{display:flex;flex-wrap:wrap;gap:8px}
.dshs-page .dshs-btn{max-width:100%;height:auto;min-height:32px;padding:6px 12px;white-space:normal;overflow-wrap:anywhere}
.dshs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.dshs-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;margin-top:6px}
.dshs-limits{margin-top:18px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
`;

    function Style() {
      return h('style', null, STYLE);
    }

    function LockIcon() {
      return h('svg', { className: 'dshs-lock', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 4, y: 11, width: 16, height: 10, rx: 2 }),
        h('path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }));
    }

    function format(text, vars) {
      return text.replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? String(vars[k]) : `{${k}}`));
    }

    function makeApi(ctx) {
      return async function call(method, payload) {
        const connection = ctx.get('connection');
        if (!connection) throw new Error('connection unavailable');
        const result = await connection.rpc.call('/api', method, payload ?? {});
        if (!result || !result.ok) throw new Error(result?.error?.message ?? 'request failed');
        return result.value;
      };
    }

    function parseArgs(raw) {
      try { return JSON.parse(raw || '{}'); } catch { return {}; }
    }

    function resultValue(block) {
      const text = (block?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      try { return JSON.parse(text); } catch { return null; }
    }

    function SecretForm({ callId, api, t, args }) {
      const [form, setForm] = useState(null);
      const [values, setValues] = useState({});
      const [shown, setShown] = useState({});
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const first = useRef(null);

      useEffect(() => {
        let alive = true;
        let timer;
        const load = async () => {
          try {
            const value = await api(M.describe, { callId });
            if (!alive) return;
            setForm(value);
            // The dock can mount before the Host registers the pending form.
            if (!value.open) timer = setTimeout(load, 700);
          } catch (e) {
            if (alive) setError(e.message);
          }
        };
        load();
        return () => { alive = false; clearTimeout(timer); };
      }, [callId]);

      useEffect(() => {
        if (form?.open && first.current) first.current.focus();
      }, [form?.open]);

      // Clear any typed values when the form unmounts.
      useEffect(() => () => setValues({}), []);

      const submit = useCallback(async (event) => {
        event?.preventDefault?.();
        if (!form?.open || busy) return;
        const missing = form.fields.filter((f) => !f.exists && !(values[f.name] ?? '').length);
        if (missing.length > 0) { setError(`${t('required')}: ${missing.map((f) => f.name).join(', ')}`); return; }
        setBusy(true);
        setError('');
        try {
          await api(M.submit, { callId, values });
          setValues({});
          setForm({ open: false, done: true });
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }, [form, values, busy, callId]);

      const cancel = useCallback(async () => {
        if (busy) return;
        setValues({});
        setBusy(true);
        try {
          await api(M.cancel, { callId });
          setForm({ open: false, done: true });
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }, [callId, busy]);

      if (form?.done) return null;
      const names = Array.isArray(args.names) ? args.names : [];
      if (!form || !form.open) {
        return h('div', { className: 'dshs-card' }, h(Style),
          h('div', { className: 'dshs-head' }, h(LockIcon),
            h('div', null,
              h('div', { className: 'dshs-title' }, `${t('title')}: ${names.join(', ')}`),
              h('div', { className: 'dshs-sub' }, form ? t('waiting') : t('loading')),
              error ? h('div', { className: 'dshs-error' }, error) : null)));
      }

      return h('form', { className: 'dshs-card', onSubmit: submit, autoComplete: 'off', 'data-dsh-secrets-form': callId }, h(Style),
        h('div', { className: 'dshs-head' }, h(LockIcon),
          h('div', null,
            h('div', { className: 'dshs-title' }, t('title')),
            h('div', { className: 'dshs-sub' }, `${t('purpose')}: ${form.purpose}`))),
        h('div', { className: 'dshs-body' },
          form.fields.map((field, index) => h('div', { className: 'dshs-field', key: field.name },
            h('label', { className: 'dshs-label', htmlFor: `dshs-${callId}-${field.name}` },
              h('span', null, field.name),
              field.description ? h('span', { className: 'dshs-desc' }, field.description) : null),
            h('div', { className: 'dshs-row' },
              h('input', {
                id: `dshs-${callId}-${field.name}`,
                ref: index === 0 ? first : undefined,
                className: 'dshs-input',
                type: shown[field.name] ? 'text' : 'password',
                name: `dshs-${field.name}`,
                autoComplete: 'new-password',
                autoCapitalize: 'none',
                autoCorrect: 'off',
                spellCheck: false,
                'data-1p-ignore': true,
                'data-lpignore': 'true',
                placeholder: field.exists ? t('exists') : t('required'),
                value: values[field.name] ?? '',
                onChange: (e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value })),
                disabled: busy,
              }),
              h('button', {
                type: 'button', className: 'dshs-btn',
                onClick: () => setShown((prev) => ({ ...prev, [field.name]: !prev[field.name] })),
              }, shown[field.name] ? t('hide') : t('show'))))),
          h('div', { className: 'dshs-note' }, t('writesTo'), ' ', h('span', { className: 'dshs-path' }, form.path), t('mode'), '. ', t('note')),
          error ? h('div', { className: 'dshs-error', role: 'alert' }, error) : null),
        h('div', { className: 'dshs-actions' },
          h('button', { type: 'button', className: 'dshs-btn', onClick: cancel, disabled: busy }, t('cancel')),
          h('button', { type: 'submit', className: 'dshs-btn dshs-primary', disabled: busy }, busy ? t('saving') : t('save'))));
    }

    function SecretSettled({ block, t, args }) {
      const value = resultValue(block);
      const names = Array.isArray(args.names) ? args.names : [];
      let status;
      if (block.isError) status = h('span', { className: 'dshs-danger' }, t('failed'));
      else if (value?.status === 'provided') status = h('span', { className: 'dshs-ok' }, t('provided'));
      else if (value?.reason === 'timeout') status = t('timeout');
      else status = t('cancelled');
      const kept = value?.kept?.length ? ` · ${value.kept.join(', ')} ${t('kept')}` : '';
      return h('div', { className: 'dshs-card' }, h(Style),
        h('div', { className: 'dshs-done' }, h(LockIcon),
          h('b', null, names.join(', ')), status,
          value?.path ? h('span', { className: 'dshs-path' }, value.path) : null,
          kept ? h('span', null, kept) : null));
    }

    const EMPTY_CALLS = [];
    const EMPTY_SOURCE = { getSnapshot: () => EMPTY_CALLS, subscribe: () => () => {} };

    function openTurn(snapshot) {
      const turn = snapshot.timeline.turnOrder.at(-1);
      return snapshot.timeline.turns.get(turn)?.status === 'open' ? turn : undefined;
    }

    function makeSecretDock(api) {
      return function SecretDock({ useChat, sessionId, t }) {
        const turn = useChat(openTurn);
        const nodes = useChat((snapshot) => snapshot.nodes);
        // This projected source includes tools hidden by collapsed process groups.
        const source = useMemo(() => turn === undefined ? EMPTY_SOURCE : nodes.turnDataSource(turn, 'tool-call'), [nodes, turn]);
        const calls = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
        const active = calls.find(({ root }) => root.phase === 'start' && root.name === 'request_secret' && !('kind' in root))?.root;
        if (!active) return null;
        return h('div', { className: 'dshs-dock' },
          h(SecretForm, { key: `${sessionId}:${active.callId}`, callId: active.callId, api, t, args: parseArgs(active.argsRaw) }));
      };
    }

    function makeToolView() {
      return function RequestSecretView(props) {
        const t = props.t ?? ((k) => en[k] ?? k);
        if (props.phase === 'preparing') {
          return h('div', { className: 'dshs-card' }, h(Style),
            h('div', { className: 'dshs-head' }, h(LockIcon), h('div', { className: 'dshs-sub' }, t('loading'))));
        }
        const block = props.block ?? {};
        const settled = 'kind' in block || props.phase === 'result';
        const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? '';
        const args = parseArgs(argsRaw);
        if (settled) return h(SecretSettled, { block, t, args });
        const names = Array.isArray(args.names) ? args.names : [];
        return h('div', { className: 'dshs-card' }, h(Style),
          h('div', { className: 'dshs-head' }, h(LockIcon),
            h('div', null,
              h('div', { className: 'dshs-title' }, `${t('title')}: ${names.join(', ')}`),
              h('div', { className: 'dshs-sub' }, t('waiting')))));
      };
    }

    function CredentialEntry({ entry, t, remove }) {
      return h('article', { className: 'dshs-entry' },
        h('h3', { className: 'dshs-mono' }, entry.name),
        entry.tooShort ? h('div', { className: 'dshs-warn' }, t('tooShort')) : null,
        h('dl', { className: 'dshs-details' },
          h('div', { className: 'dshs-file' },
            h('dt', null, t('colFile')), h('dd', { className: 'dshs-mono' }, entry.path)),
          h('div', null,
            h('dt', null, t('colFp')), h('dd', { className: 'dshs-mono' }, entry.fingerprint)),
          h('div', null,
            h('dt', null, t('colUpdated')), h('dd', null,
              h('time', { dateTime: entry.updatedAt }, new Date(entry.updatedAt).toLocaleString())))),
        h('div', { className: 'dshs-entry-actions' },
          h('button', { type: 'button', className: 'dshs-btn', onClick: () => remove(entry, false) }, t('untrack')),
          h('button', { type: 'button', className: 'dshs-btn dshs-danger', onClick: () => remove(entry, true) }, t('delete'))));
    }

    function makeSettings(api) {
      return function SecretsSettings(props) {
        const t = props.t;
        const [state, setState] = useState({ loading: true, entries: [], error: '' });
        const load = useCallback(async () => {
          try {
            const value = await api(M.list, {});
            setState({ loading: false, entries: value.entries, error: '' });
          } catch (e) {
            setState((s) => ({ ...s, loading: false, error: e.message }));
          }
        }, []);
        useEffect(() => { load(); }, [load]);
        const remove = async (entry, deleteFromFile) => {
          if (deleteFromFile && !window.confirm(format(t('confirmDelete'), { name: entry.name }))) return;
          try { await api(M.remove, { path: entry.path, name: entry.name, deleteFromFile }); } catch (e) { setState((s) => ({ ...s, error: e.message })); }
          load();
        };
        return h('div', { className: 'dshs-page' }, h(Style),
          h('div', { className: 'dshs-page-head' },
            h('h2', null, t('settingsTitle')),
            h('button', { className: 'dshs-btn', onClick: load }, t('refresh'))),
          h('p', null, t('settingsIntro')),
          state.error ? h('div', { className: 'dshs-error' }, state.error) : null,
          !state.loading && state.entries.length === 0 ? h('p', null, t('empty')) : null,
          state.entries.length > 0 ? h('ul', { className: 'dshs-entries' },
            state.entries.map((entry) => h('li', { key: `${entry.path}\0${entry.name}` },
              h(CredentialEntry, { entry, t, remove })))) : null,
          h('div', { className: 'dshs-limits' }, t('limits')));
      };
    }

    return {
      name: 'dsh-secrets',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-secrets: locale');
        const t = ctx.locale.bind(NS);
        const api = makeApi(ctx);
        const ToolView = makeToolView();
        const SecretDock = makeSecretDock(api);
        const Settings = makeSettings(api);
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-secrets',
          order: -20,
          locale: NS,
        }, SecretDock));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'request_secret',
          locale: NS,
        }, ToolView));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-secrets',
          order: 60,
          label: () => t('section'),
          inject: () => ({ t }),
        }, Settings));
      },
    };
  },
});
