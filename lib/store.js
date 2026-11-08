// Secret store: dotenv files hold values; registry.json holds metadata only
// (NAME, absolute path, short value fingerprint, timestamps). The redactor is
// rebuilt from the dotenv files at startup so L2 survives restarts.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assignedNames, DotenvError, readValues, reconcile, removeNames } from './dotenv.js';
import { Redactor } from './redactor.js';

const REGISTRY_VERSION = 1;

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function fingerprint(value) {
  return `sha256:${sha256(`dsh-secrets:${value}`).slice(0, 8)}`;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Write via a 0600 temp file + rename, failing when `expectedSha` no longer matches. */
async function writeIfUnchanged(path, content, expectedSha) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.dsh-secrets.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const current = await readText(path);
    const currentSha = current === null ? null : sha256(current);
    if (currentSha !== expectedSha) return false;
    await rename(tmp, path);
    await chmod(path, 0o600);
    return true;
  } finally {
    await rm(tmp, { force: true });
  }
}

async function canonical(path) {
  const abs = resolve(path);
  try {
    return await realpath(abs);
  } catch {
    try {
      return join(await realpath(dirname(abs)), abs.slice(dirname(abs).length + 1));
    } catch {
      return abs;
    }
  }
}

export class SecretStore {
  /**
   * @param {object} options
   * @param {string} options.dataDir directory for registry.json
   * @param {(msg: string) => void} [options.warn]
   */
  constructor({ dataDir, warn = () => {} }) {
    this.dataDir = dataDir;
    this.registryPath = join(dataDir, 'registry.json');
    this.warn = warn;
    this.redactor = new Redactor();
    /** @type {Array<{name: string, path: string, fingerprint: string, createdAt: string, updatedAt: string, tooShort?: boolean}>} */
    this.entries = [];
    this.listeners = new Set();
    this.queue = Promise.resolve();
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* listener failures never break the store */ }
    }
  }

  /** Serialize mutations so registry writes never interleave. */
  serial(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async load() {
    const raw = await readText(this.registryPath);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (parsed?.version !== REGISTRY_VERSION || !Array.isArray(parsed.entries)) throw new Error('dsh-secrets: unsupported registry.json');
      this.entries = parsed.entries;
    }
    await this.rebuildRedactor();
  }

  async rebuildRedactor() {
    const byPath = new Map();
    for (const entry of this.entries) {
      if (!byPath.has(entry.path)) byPath.set(entry.path, []);
      byPath.get(entry.path).push(entry.name);
    }
    this.redactor = new Redactor();
    for (const [path, names] of byPath) {
      const content = await readText(path).catch(() => null);
      if (content === null) continue;
      const values = readValues(content, names);
      for (const [name, value] of Object.entries(values)) this.redactor.set(this.redactKey(path, name), value, name);
    }
  }

  /** Redaction table key: NAME alone is shown to the model; path disambiguates internally. */
  redactKey(path, name) {
    return `${path}\0${name}`;
  }

  async saveRegistry() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ version: REGISTRY_VERSION, entries: this.entries }, null, 2)}\n`;
    const tmp = `${this.registryPath}.${randomBytes(4).toString('hex')}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(body, 'utf8'); } finally { await handle.close(); }
    await rename(tmp, this.registryPath);
  }

  /** Absolute canonical paths of all managed dotenv files. */
  protectedPaths() {
    return new Set(this.entries.map((e) => e.path));
  }

  /** Names of all managed variables. */
  names() {
    return new Set(this.entries.map((e) => e.name));
  }

  list() {
    return this.entries.map((e) => ({ ...e }));
  }

  async resolvePath(path) {
    return canonical(path);
  }

  /** Which of `names` already have a value in `path` (no values returned). */
  async existing(path, names) {
    const content = await readText(path);
    return content === null ? [] : assignedNames(content, names);
  }

  /**
   * Write submitted values. `values` may omit names the user left blank when
   * the variable already exists in the file.
   */
  write(path, values) {
    return this.serial(async () => {
      let attempt = 0;
      for (;;) {
        const current = (await readText(path)) ?? '';
        const exists = (await stat(path).catch(() => null)) !== null;
        const result = reconcile(current, values);
        const ok = await writeIfUnchanged(path, result.content, exists ? sha256(current) : null);
        if (ok) {
          const now = new Date().toISOString();
          for (const [name, value] of Object.entries(values)) {
            const tooShort = !this.redactor.set(this.redactKey(path, name), value, name);
            const prior = this.entries.find((e) => e.name === name && e.path === path);
            const fields = { fingerprint: fingerprint(value), updatedAt: now, ...(tooShort ? { tooShort: true } : {}) };
            if (prior) {
              Object.assign(prior, fields);
              if (!tooShort) delete prior.tooShort;
            } else {
              this.entries.push({ name, path, createdAt: now, ...fields });
            }
          }
          await this.saveRegistry();
          this.emit();
          return { added: result.added, updated: result.updated, unchanged: result.unchanged };
        }
        attempt += 1;
        if (attempt >= 3) throw new DotenvError('dotenv file kept changing while secrets were written; nothing was written', 'write_conflict');
      }
    });
  }

  /** Track names that already exist in `path` without changing their values. */
  adopt(path, names) {
    return this.serial(async () => {
      const content = (await readText(path)) ?? '';
      const values = readValues(content, names);
      const now = new Date().toISOString();
      for (const name of names) {
        if (!(name in values)) continue;
        const tooShort = !this.redactor.set(this.redactKey(path, name), values[name], name);
        if (!this.entries.some((e) => e.name === name && e.path === path)) {
          this.entries.push({ name, path, createdAt: now, updatedAt: now, fingerprint: fingerprint(values[name]), ...(tooShort ? { tooShort: true } : {}) });
        }
      }
      await this.saveRegistry();
      this.emit();
    });
  }

  /**
   * Stop managing NAME in path. With `deleteFromFile`, also remove the line.
   * The redactor keeps the old value until restart unless the line is
   * removed, because the value may still be in use by a running program.
   */
  remove(path, name, { deleteFromFile = false } = {}) {
    return this.serial(async () => {
      if (deleteFromFile) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await readText(path);
          if (current === null) break;
          const result = removeNames(current, [name]);
          if (await writeIfUnchanged(path, result.content, sha256(current))) break;
          if (attempt === 2) throw new DotenvError('dotenv file kept changing; nothing was removed', 'write_conflict');
        }
      }
      this.entries = this.entries.filter((e) => !(e.name === name && e.path === path));
      if (deleteFromFile) this.redactor.delete(this.redactKey(path, name));
      await this.saveRegistry();
      this.emit();
    });
  }
}
