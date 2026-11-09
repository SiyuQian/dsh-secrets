// L1 (deny reads of managed dotenv files) and L3 (ask before a shell command
// combines a managed secret with an output/network verb). Pure functions over
// tool name + arguments so they are testable without a Harness.

import { basename, dirname, isAbsolute, resolve } from 'node:path';

const READ_VERBS = [
  'cat', 'tac', 'less', 'more', 'head', 'tail', 'sed', 'awk', 'gawk', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'strings', 'xxd', 'od', 'hexdump', 'base64', 'base32', 'cp', 'mv', 'rsync', 'scp', 'source', '.', 'nl',
  'cut', 'sort', 'uniq', 'paste', 'tr', 'diff', 'cmp', 'vi', 'vim', 'nano', 'emacs', 'code', 'open', 'bat',
  'jq', 'yq', 'python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun', 'dotenv', 'env', 'tee',
  'zip', 'tar', 'gzip', 'openssl', 'gpg', 'curl', 'wget', 'git', 'pbcopy', 'xargs', 'while', 'read', 'readarray', 'mapfile',
];

const OUTPUT_VERBS = [
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'http', 'https', 'httpie',
  'echo', 'printf', 'env', 'printenv', 'set', 'export', 'declare', 'typeset', 'compgen', 'tee', 'pbcopy',
  'python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun', 'osascript', 'open', 'git',
];

/** Tool argument fields that name a single file. */
const FILE_FIELDS = ['file_path', 'path', 'filePath', 'filename', 'target', 'source', 'destination'];

/** Shell-like tools whose `command` (or `script`) we inspect. */
export const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal', 'terminal_bash', 'terminal_write', 'shell', 'exec']);

function wordPattern(words) {
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return new RegExp(`(?:^|[\\s;&|(\`$])(?:${escaped.join('|')})(?=$|[\\s;&|)<>])`, 'u');
}

const READ_VERB_RE = wordPattern(READ_VERBS);
const OUTPUT_VERB_RE = wordPattern(OUTPUT_VERBS);

function stringArgs(args) {
  if (args === null || typeof args !== 'object') return [];
  const out = [];
  const walk = (value, depth) => {
    if (depth > 4) return;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) walk(v, depth + 1);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
  };
  walk(args, 0);
  return out;
}

export function shellText(args) {
  if (args === null || typeof args !== 'object') return '';
  return [args.command, args.script, args.input, args.text, args.keys]
    .filter((v) => typeof v === 'string').join('\n');
}

/**
 * @param {object} input
 * @param {string} input.tool
 * @param {any} input.args
 * @param {string|undefined} input.cwd
 * @param {Set<string>} input.protectedPaths absolute paths of managed dotenv files
 * @returns {string|undefined} denial reason
 */
export function readDenial({ tool, args, cwd, protectedPaths }) {
  if (protectedPaths.size === 0 || args === null || typeof args !== 'object') return undefined;
  const reason = (path) => `${path} is managed by dsh-secrets and its contents are not readable or editable by the agent. Load it from the program (dotenv) instead, or call request_secret to change a value.`;

  // Direct file arguments (read, write, edit, str_replace_editor, read_image, ...).
  for (const field of FILE_FIELDS) {
    const value = args[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    const abs = isAbsolute(value) ? resolve(value) : cwd ? resolve(cwd, value) : undefined;
    if (abs !== undefined && protectedPaths.has(abs)) return reason(abs);
  }

  // Search tools pointed at a directory that holds a protected file, whose
  // filename filter (if any) could match it.
  // glob only lists paths, which reveals no contents, so it stays allowed.
  if (tool === 'grep') {
    const base = typeof args.path === 'string' ? (isAbsolute(args.path) ? resolve(args.path) : cwd ? resolve(cwd, args.path) : undefined) : cwd;
    const filter = args.include ?? args.glob;
    for (const file of protectedPaths) {
      const inside = base !== undefined && (file === base || file.startsWith(`${base}/`));
      if (!inside) continue;
      if (typeof filter === 'string' && filter.length > 0 && !globMatches(filter, file.slice(base.length + 1))) continue;
      return reason(file);
    }
  }

  // Shell commands that mention a protected file next to a read-ish verb.
  if (SHELL_TOOLS.has(tool)) {
    const text = shellText(args);
    if (text.length === 0) return undefined;
    for (const file of protectedPaths) {
      const name = basename(file);
      // Match a complete filename, not `.env` inside `process.env` or
      // `.env.example`. Keep basename matching conservative across workspaces:
      // shell commands can change directories or run on remote machines.
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const filename = new RegExp(`(?:^|[^\\p{L}\\p{N}_.$~-]|\\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]))${escapedName}(?=$|[^\\p{L}\\p{N}_./~-])`, 'u');
      const mentioned = filename.test(text) || (name.startsWith('.env') && /\.env\*|\.env\?|\.\*env|\*\.env/u.test(text));
      if (mentioned && READ_VERB_RE.test(text)) return reason(file);
    }
    // Generic: dumping the whole environment of a process that loaded a
    // dotenv is out of scope; dumping the dotenv itself via wildcard is covered above.
  }

  // Any other tool that carries the exact protected path in some string arg.
  if (!SHELL_TOOLS.has(tool) && tool !== 'grep' && tool !== 'glob') {
    for (const text of stringArgs(args)) {
      for (const file of protectedPaths) if (text === file) return reason(file);
    }
  }
  return undefined;
}

/**
 * L3: a shell command references a managed variable AND an output/network
 * verb. Returns the matched names, or [] when no approval is needed.
 */
export function exfilNames({ tool, args, names }) {
  if (!SHELL_TOOLS.has(tool) || names.size === 0) return [];
  const text = shellText(args);
  if (text.length === 0 || !OUTPUT_VERB_RE.test(text)) return [];
  const hits = [];
  for (const name of names) {
    const re = new RegExp(`\\$\\{?${name}\\b|\\b${name}\\b`, 'u');
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

/** Minimal glob match (*, **, ?, {a,b}) against a relative path or its basename. */
export function globMatches(glob, relative) {
  const expand = (g) => {
    const m = /\{([^{}]*)\}/u.exec(g);
    if (!m) return [g];
    return m[1].split(',').flatMap((alt) => expand(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
  };
  const toRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*\*\/?/gu, '\u0000').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]').replace(/\u0000/gu, '.*')}$`, 'u');
  const name = basename(relative);
  return expand(glob).some((g) => {
    const re = toRe(g);
    return re.test(relative) || (!g.includes('/') && re.test(name));
  });
}

export function parentDir(path) {
  return dirname(path);
}
