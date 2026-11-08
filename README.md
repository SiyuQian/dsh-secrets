# dsh-secrets

English | [简体中文](./README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets the agent ask you for API keys, passwords, and tokens through a secure form, without the values ever reaching the model.

## How it works

1. The agent calls `request_secret` with the variable names, a purpose, and a dotenv file.
2. A password form opens above the chat input and focuses the first field. It stays accessible even when the conversation's work details are collapsed; the tool row shows the request status.
3. You type the values. They travel over an authenticated `/api/dsh-secrets.*` route straight to the Host. They are never a tool argument, a tool result, or a session event.
4. The values are written to the dotenv file with mode `0600`. Existing lines, comments, and line endings are kept.
5. The agent receives only `{ status, path, names, added, updated, unchanged, kept }`.

The bundled `secrets` skill teaches the agent when and how to call the tool.

Documentation is available in English and Simplified Chinese, with English as the default entry point. The interface and approval prompts support both languages and follow the Harness locale setting, with English as the fallback.

## Defences

| Layer | Mechanism | What it does |
|---|---|---|
| L1 read guard | `ctx.tools.guard()` | Denies `read`/`edit`/`write`/`grep`, and shell commands that read a managed file (`cat`, `cp`, `source`, `python -c open(...)`, …). Other plugins cannot override the denial. |
| L2 redaction | `tools/post-execute` | Replaces managed values in every tool result with `[REDACTED:NAME]`, including base64 (all alignments, e.g. inside Basic auth), URL encoding, JSON escaping, and hex. If redaction fails, the output is withheld. |
| L3 approval | `tools/pre-execute` → `ask` | A shell command that uses a managed variable together with `curl`, `echo`, `printenv`, `ssh`, … asks you first. |
| No values in logs | Separate fetch route | The session log records only names, path, and counts. `registry.json` stores names, paths, and an 8-char fingerprint. |

Other rules:

- `env_file` must be inside the working directory.
- Subagents and `run_code` (PTC) programs cannot open the form.
- After you cancel, the same names cannot be requested again in that turn.

**Settings → Secrets** lists each managed variable in a responsive card, with its full file path, fingerprint, update time, and actions. Long names and paths wrap within the panel instead of requiring horizontal scrolling. You can stop managing a variable, or delete it from its file. The page does not show values.

## Known limits

- An agent that writes its own program to read the file and transform the value arbitrarily before sending it can get past L1–L3. Use it in workspaces you trust. These defences raise the bar; they are not a sandbox.
- Values shorter than 6 characters cannot be redacted. The settings page flags them.
- Approval (L3) is per command. There is no "always allow for this session" button yet.
- Only dotenv files are supported (no Keychain, no environment injection).

## Install

Requires DeepSeek Harness 0.2.x and Node 22 or later.

From inside a Harness session, ask the agent to install the bundle:

```
plugin_manager install_bundle  target: https://github.com/SiyuQian/dsh-secrets.git
```

Or clone the repo and install from the local directory:

```
git clone https://github.com/SiyuQian/dsh-secrets.git
# then in Harness: plugin_manager install_bundle  target: /absolute/path/to/dsh-secrets
```

Refresh the Web GUI after installing.

## Configuration

Optional. Set these in your profile `cordis.patch.yml`:

```yaml
- id: dsh-secrets
  name: dsh-secrets
  config:
    timeoutMs: 600000        # form timeout, default 10 min
    dataDir: /abs/path       # registry location, default $DSH_HOME/plugins/dsh-secrets
    allowOutsideCwd: false   # allow env_file outside the working directory
```

## Development

```
npm ci --ignore-scripts
npm test   # node:test; Client tests use React and react-test-renderer
```

| File | Contents |
|---|---|
| `lib/index.js` | Host: tool, routes, guard, hooks, skill provider |
| `lib/dotenv.js` | Dotenv reconcile, parse, and remove |
| `lib/redactor.js` | Value-variant redaction |
| `lib/policy.js` | L1 and L3 rules |
| `lib/store.js` | Atomic `0600` writes with sha256 conflict retry, and the registry |
| `client/client.js` | Credential input dock, tool status, and settings cards (plain JS, no build step) |
| [API findings](./docs/api-findings.md) / [API 调研结论](./docs/api-findings.zh-CN.md) | The Harness APIs this plugin relies on, with sources |

Keep both documentation editions in sync when changing behavior, commands, or security limits. Code identifiers, protocol fields, and shared command examples remain in English. The bundled agent skill uses one English source so agents receive the same safety instructions in either UI language.

## License

MIT
