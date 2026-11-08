// Dotenv reconciliation: update named assignments in place, keep everything
// else (comments, ordering, line endings) byte-for-byte. Error messages never
// contain secret values.

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
export const MAX_VALUE_BYTES = 16 * 1024;

const ANY_ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/u;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function assignmentPattern(name) {
  return new RegExp(`^(\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=\\s*)(.*)$`, 'u');
}

function hasClosingQuote(text, quote) {
  let escaped = false;
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && ch === '\\') { escaped = true; continue; }
    if (ch === quote) return true;
  }
  return false;
}

/** Throw when the file has a quoted value spanning lines; we cannot rewrite it safely. */
export function assertNoMultilineQuotes(content) {
  for (const line of content.split(/\r?\n/u)) {
    const value = ANY_ASSIGNMENT.exec(line)?.[1] ?? '';
    const first = value[0];
    if ((first === '"' || first === "'") && !hasClosingQuote(value, first)) {
      throw new DotenvError('dotenv file has a multi-line quoted value; dsh-secrets cannot rewrite it safely', 'multiline_quoted_value');
    }
  }
}

export class DotenvError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DotenvError';
    this.code = code;
  }
}

/** Throw when any of `names` is assigned more than once. */
export function assertNoDuplicates(content, names) {
  assertNoMultilineQuotes(content);
  const lines = content.split(/\r?\n/u);
  for (const name of names) {
    const pattern = assignmentPattern(name);
    if (lines.filter((line) => pattern.test(line)).length > 1) {
      throw new DotenvError(`dotenv file assigns ${name} more than once; remove the duplicate line and retry`, 'duplicate_assignment');
    }
  }
}

/** Validate one submitted value. The message names the variable, never the value. */
export function validateValue(name, value) {
  if (typeof value !== 'string' || value.length === 0) throw new DotenvError(`${name}: value is empty`, 'empty_value');
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw new DotenvError(`${name}: value exceeds 16 KiB`, 'value_too_large');
  if (value.includes('\n') || value.includes('\r')) throw new DotenvError(`${name}: value must be a single line`, 'multiline_value');
  if (value.includes('\0')) throw new DotenvError(`${name}: value must not contain NUL`, 'nul_value');
}

/** Encode a value as one safe dotenv right-hand side. */
export function encodeValue(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\') && !value.includes('$')) return `"${value}"`;
  throw new DotenvError('a value contains both quote styles and cannot be written safely to dotenv', 'unrepresentable_value');
}

/** Return a trailing ` # comment` after an unquoted or closed-quoted value, if any. */
function trailingComment(rhs) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < rhs.length; i += 1) {
    const ch = rhs[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote === '"') { escaped = true; continue; }
    if (ch === "'" || ch === '"') { quote = quote === ch ? null : (quote ?? ch); continue; }
    if (ch !== '#' || quote !== null || i === 0 || !/\s/u.test(rhs[i - 1])) continue;
    let start = i;
    while (start > 0 && /\s/u.test(rhs[start - 1])) start -= 1;
    return rhs.slice(start);
  }
  return '';
}

/**
 * Write `values` into `content`. Existing assignments are replaced in place,
 * missing ones are appended. Returns the new content and counts.
 */
export function reconcile(content, values) {
  const names = Object.keys(values);
  for (const name of names) {
    if (!NAME_PATTERN.test(name)) throw new DotenvError(`invalid variable name ${JSON.stringify(name)}`, 'invalid_name');
    validateValue(name, values[name]);
  }
  assertNoDuplicates(content, names);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const endsWithEol = content.endsWith('\n');
  const lines = content.length === 0 ? [] : content.split(/\r?\n/u);
  if (endsWithEol) lines.pop();
  const pending = new Set(names);
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const out = lines.map((line) => {
    for (const name of names) {
      const match = assignmentPattern(name).exec(line);
      if (!match) continue;
      pending.delete(name);
      const next = `${match[1]}${encodeValue(values[name])}${trailingComment(match[2] ?? '')}`;
      if (next === line) unchanged += 1; else updated += 1;
      return next;
    }
    return line;
  });
  for (const name of names) {
    if (!pending.has(name)) continue;
    out.push(`${name}=${encodeValue(values[name])}`);
    added += 1;
  }
  const joined = out.join(eol);
  const text = joined.length === 0 ? '' : `${joined}${endsWithEol || added > 0 ? eol : ''}`;
  return { content: text, added, updated, unchanged };
}

/** Remove every assignment of `names`. Returns new content and the removed count. */
export function removeNames(content, names) {
  assertNoMultilineQuotes(content);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const endsWithEol = content.endsWith('\n');
  const lines = content.length === 0 ? [] : content.split(/\r?\n/u);
  if (endsWithEol) lines.pop();
  const patterns = names.map(assignmentPattern);
  const kept = lines.filter((line) => !patterns.some((p) => p.test(line)));
  const removed = lines.length - kept.length;
  const joined = kept.join(eol);
  return { content: joined.length === 0 ? '' : `${joined}${endsWithEol ? eol : ''}`, removed };
}

function decodeRhs(rhs) {
  const value = rhs.trim();
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end < 0 ? value.slice(1) : value.slice(1, end);
  }
  if (value.startsWith('"')) {
    let out = '';
    for (let i = 1; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === '\\' && i + 1 < value.length) {
        const nx = value[i + 1];
        out += nx === 'n' ? '\n' : nx === 'r' ? '\r' : nx === 't' ? '\t' : nx;
        i += 1;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  }
  return value.replace(/\s+#.*$/u, '').trim();
}

/** Read the current values of `names` (for redaction tables only; never returned to a model). */
export function readValues(content, names) {
  const values = {};
  for (const line of content.split(/\r?\n/u)) {
    for (const name of names) {
      const match = assignmentPattern(name).exec(line);
      if (match) values[name] = decodeRhs(match[2] ?? '');
    }
  }
  return values;
}

/** Names assigned in `content` (used to show "already set"). */
export function assignedNames(content, names) {
  return names.filter((name) => content.split(/\r?\n/u).some((line) => assignmentPattern(name).test(line)));
}
