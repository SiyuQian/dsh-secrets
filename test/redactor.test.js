import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redactor } from '../lib/redactor.js';

const SECRET = 'S3NTINEL-q8Zx41-pass';

function redactor() {
  const r = new Redactor();
  r.set('k', SECRET, 'API_KEY');
  return r;
}

test('plain value', () => {
  const { text, hits } = redactor().redact(`token=${SECRET} done`);
  assert.equal(text, 'token=[REDACTED:API_KEY] done');
  assert.deepEqual(hits, ['API_KEY']);
});

test('base64 at every alignment, including inside Basic auth', () => {
  const r = redactor();
  for (const prefix of ['', 'u:', 'us:', 'use:']) {
    const encoded = Buffer.from(`${prefix}${SECRET}`).toString('base64');
    const out = r.redact(`Authorization: Basic ${encoded}`).text;
    assert.match(out, /REDACTED:API_KEY/u, prefix);
  }
});

test('url-safe base64', () => {
  const encoded = Buffer.from(`??${SECRET}`).toString('base64url');
  assert.match(redactor().redact(encoded).text, /REDACTED/u);
});

test('url encoding, JSON escape, hex', () => {
  const r = new Redactor();
  const value = 'p@ss/w"rd&x=1';
  r.set('k', value, 'DB_PASS');
  assert.match(r.redact(encodeURIComponent(value)).text, /REDACTED:DB_PASS/u);
  assert.match(r.redact(JSON.stringify({ v: value })).text, /REDACTED:DB_PASS/u);
  assert.match(r.redact(Buffer.from(value).toString('hex')).text, /REDACTED:DB_PASS/u);
});

test('too-short values are refused', () => {
  const r = new Redactor();
  assert.equal(r.set('k', '12345', 'PIN'), false);
  assert.equal(r.size, 0);
});

test('delete keeps a shared value tracked by another key', () => {
  const r = new Redactor();
  r.set('a', SECRET, 'A');
  r.set('b', SECRET, 'B');
  r.delete('a');
  assert.match(r.redact(SECRET).text, /REDACTED:B/u);
  r.delete('b');
  assert.equal(r.redact(SECRET).text, SECRET);
});

test('redactContent only touches text blocks and reports unchanged as undefined', () => {
  const r = redactor();
  assert.equal(r.redactContent([{ type: 'text', text: 'nothing' }]), undefined);
  const res = r.redactContent([{ type: 'image', data: SECRET }, { type: 'text', text: SECRET }]);
  assert.equal(res.content[0].data, SECRET);
  assert.equal(res.content[1].text, '[REDACTED:API_KEY]');
});

test('special regex characters in values', () => {
  const r = new Redactor();
  r.set('k', 'a.b*c+d?(e)[f]', 'X');
  assert.equal(r.redact('a.b*c+d?(e)[f]').text, '[REDACTED:X]');
  assert.equal(r.redact('aXb*c+d?(e)[f]').text, 'aXb*c+d?(e)[f]');
});
