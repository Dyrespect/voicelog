import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openPrintStore } from '../src/printsStore.mjs';

test('声纹库：一个人一行，空的不能盖掉已有的人', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voicelog-prints-'));
  const store = openPrintStore(join(dir, 'voiceprints.db'));
  assert.equal(store.count(), 0);
  const v = Float32Array.from([1, 0, 0]);
  store.writeAll({ 我: { v, name: '戴敬力' } });
  const back = store.read();
  assert.equal(back['我'].name, '戴敬力');
  assert.equal(back['我'].v[0], 1);
  assert.throws(() => store.writeAll({}), /拒绝用空声纹/);
  assert.equal(store.read()['我'].name, '戴敬力');
  store.writeAll({ 我: { v, name: '戴敬力' }, 小红: { v: Float32Array.from([0, 1]), name: '小红' } });
  assert.deepEqual(Object.keys(store.read()).sort(), ['小红', '我']);
});
