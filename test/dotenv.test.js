import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignedNames, encodeValue, readValues, reconcile, removeNames, validateValue } from '../lib/dotenv.js';

test('appends to empty content', () => {
  const r = reconcile('', { A: 'x1' });
  assert.equal(r.content, "A='x1'\n");
  assert.deepEqual([r.added, r.updated, r.unchanged], [1, 0, 0]);
});

test('updates in place, keeps comments and order', () => {
  const src = '# header\nFOO=1\nA=old # trailing\nBAR=2\n';
  const r = reconcile(src, { A: 'new' });
  assert.equal(r.content, "# header\nFOO=1\nA='new' # trailing\nBAR=2\n");
  assert.deepEqual([r.added, r.updated, r.unchanged], [0, 1, 0]);
});

test('unchanged when already encoded identically', () => {
  const r = reconcile("A='v'\n", { A: 'v' });
  assert.equal(r.unchanged, 1);
  assert.equal(r.content, "A='v'\n");
});

test('preserves CRLF', () => {
  const r = reconcile('X=1\r\nA=2\r\n', { A: '3', B: '4' });
  assert.equal(r.content, "X=1\r\nA='3'\r\nB='4'\r\n");
});

test('file without trailing newline gets one only when appending', () => {
  assert.equal(reconcile('A=1', { A: '2' }).content, "A='2'");
  assert.equal(reconcile('A=1', { B: '2' }).content, "A=1\nB='2'\n");
});

test('handles export prefix and spaces around =', () => {
  const r = reconcile('export A = 1\n', { A: 'z' });
  assert.equal(r.content, "export A = 'z'\n");
});

test('does not touch similarly named variables', () => {
  const r = reconcile('AB=1\nA_B=2\n', { A: 'q' });
  assert.equal(r.content, "AB=1\nA_B=2\nA='q'\n");
});

test('rejects duplicate assignment', () => {
  assert.throws(() => reconcile('A=1\nA=2\n', { A: 'x' }), { code: 'duplicate_assignment' });
});

test('rejects multi-line quoted values anywhere in the file', () => {
  assert.throws(() => reconcile('K="line1\nline2"\n', { A: 'x' }), { code: 'multiline_quoted_value' });
});

test('value validation', () => {
  assert.throws(() => validateValue('A', ''), { code: 'empty_value' });
  assert.throws(() => validateValue('A', 'a\nb'), { code: 'multiline_value' });
  assert.throws(() => validateValue('A', 'a\0b'), { code: 'nul_value' });
  assert.throws(() => validateValue('A', 'x'.repeat(16 * 1024 + 1)), { code: 'value_too_large' });
});

test('error messages never contain the value', () => {
  const secret = 'S3NTINEL-abc\nxyz';
  try { reconcile('', { A: secret }); assert.fail('should throw'); } catch (e) {
    assert.ok(!e.message.includes('S3NTINEL'));
  }
});

test('encodeValue picks a safe quoting', () => {
  assert.equal(encodeValue('plain'), "'plain'");
  assert.equal(encodeValue("it's"), `"it's"`);
  assert.throws(() => encodeValue(`it's "x"`), { code: 'unrepresentable_value' });
  assert.throws(() => encodeValue("it's $HOME"), { code: 'unrepresentable_value' });
});

test('rejects invalid names', () => {
  assert.throws(() => reconcile('', { '1A': 'x' }), { code: 'invalid_name' });
  assert.throws(() => reconcile('', { 'A-B': 'x' }), { code: 'invalid_name' });
});

test('readValues decodes the common forms', () => {
  const v = readValues("A='s q'\nB=\"d\\\"q\"\nC=plain # c\nexport D=e\n", ['A', 'B', 'C', 'D']);
  assert.deepEqual(v, { A: 's q', B: 'd"q', C: 'plain', D: 'e' });
});

test('round trip: what we write reads back identically', () => {
  for (const value of ['abc', "it's", 'with space', 'sk-1234567890', 'p@ss#word', 'a=b=c']) {
    const { content } = reconcile('', { V: value });
    assert.equal(readValues(content, ['V']).V, value, value);
  }
});

test('removeNames drops lines and keeps the rest', () => {
  const r = removeNames('A=1\nB=2\nC=3\n', ['B']);
  assert.equal(r.content, 'A=1\nC=3\n');
  assert.equal(r.removed, 1);
});

test('assignedNames', () => {
  assert.deepEqual(assignedNames('A=1\n# B=2\n', ['A', 'B']), ['A']);
});
