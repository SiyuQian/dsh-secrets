// L2: replace every known secret value (and common encodings of it) with a
// placeholder. One linear scan per text via a single alternation, longest
// variant first.

export const MIN_REDACTABLE_LENGTH = 6;

function b64(buffer, urlsafe) {
  const text = buffer.toString('base64');
  return urlsafe ? text.replace(/\+/gu, '-').replace(/\//gu, '_') : text;
}

/**
 * Encoded forms that a shell or program commonly prints. For base64 we add
 * the three alignment offsets so a secret embedded inside a larger base64
 * blob (e.g. `user:pass` in a Basic auth header) is still caught.
 */
export function variantsOf(value) {
  const out = new Set([value]);
  const bytes = Buffer.from(value, 'utf8');
  for (const urlsafe of [false, true]) {
    for (let offset = 0; offset < 3; offset += 1) {
      const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
      const text = b64(padded, urlsafe);
      // Keep only the characters whose 6 bits come entirely from the value:
      // bits [8*offset, 8*(offset+n)) map to chars [ceil(4o/3), floor(4(o+n)/3)).
      const start = Math.ceil((offset * 4) / 3);
      const end = Math.floor(((offset + bytes.length) * 4) / 3);
      if (end - start >= MIN_REDACTABLE_LENGTH) out.add(text.slice(start, end));
    }
  }
  out.add(b64(bytes, false));
  out.add(encodeURIComponent(value));
  out.add(JSON.stringify(value).slice(1, -1));
  out.add(bytes.toString('hex'));
  out.add(bytes.toString('hex').toUpperCase());
  return [...out].filter((v) => v.length >= MIN_REDACTABLE_LENGTH);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export class Redactor {
  constructor() {
    /** @type {Map<string, string>} variant -> NAME */
    this.variants = new Map();
    /** @type {Map<string, Set<string>>} NAME -> variants */
    this.byName = new Map();
    this.pattern = null;
  }

  get size() {
    return this.byName.size;
  }

  /**
   * Register or replace the value tracked under `key`; matches print as
   * `[REDACTED:<label>]`. Returns false when the value is too short to redact.
   */
  set(key, value, label = key) {
    this.delete(key);
    if (typeof value !== 'string' || value.length < MIN_REDACTABLE_LENGTH) return false;
    const set = new Set(variantsOf(value));
    for (const v of set) this.variants.set(v, label);
    this.byName.set(key, { label, variants: set });
    this.pattern = null;
    return true;
  }

  delete(key) {
    const entry = this.byName.get(key);
    if (!entry) return;
    this.byName.delete(key);
    for (const v of entry.variants) this.variants.delete(v);
    // Another key may share a variant (same value in two files): restore it.
    for (const other of this.byName.values()) for (const v of other.variants) this.variants.set(v, other.label);
    this.pattern = null;
  }

  has(name) {
    return this.byName.has(name);
  }

  compiled() {
    if (this.pattern === null && this.variants.size > 0) {
      const keys = [...this.variants.keys()].sort((a, b) => b.length - a.length);
      this.pattern = new RegExp(keys.map(escapeRegExp).join('|'), 'gu');
    }
    return this.pattern;
  }

  /** @returns {{ text: string, hits: string[] }} */
  redact(text) {
    const pattern = this.compiled();
    if (pattern === null || typeof text !== 'string' || text.length === 0) return { text, hits: [] };
    const hits = new Set();
    const out = text.replace(pattern, (match) => {
      const name = this.variants.get(match) ?? 'SECRET';
      hits.add(name);
      return `[REDACTED:${name}]`;
    });
    return { text: out, hits: [...hits] };
  }

  /**
   * Redact every text block of a tool result content array. Returns undefined
   * when nothing changed so callers can keep the original decision object.
   */
  redactContent(content) {
    if (!Array.isArray(content)) return undefined;
    let changed = false;
    const hits = new Set();
    const next = content.map((block) => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return block;
      const r = this.redact(block.text);
      if (r.hits.length === 0) return block;
      changed = true;
      for (const h of r.hits) hits.add(h);
      return { ...block, text: r.text };
    });
    return changed ? { content: next, hits: [...hits] } : undefined;
  }
}
