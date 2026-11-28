import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, buildPadArt, drawPadArt } from '../js/padart.js';

test('DDLabo 風のペイント: 乱数は seed で決まり、0 以上 1 未満', () => {
  const a = makeRng(123);
  const b = makeRng(123);
  const c = makeRng(124);
  const xs = Array.from({ length: 50 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 50 }, () => b()));
  assert.notDeepEqual(xs, Array.from({ length: 50 }, () => c()));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test('DDLabo 風のペイント: 描く関数がある (ブラウザ以外では呼ばない)', () => {
  assert.equal(typeof buildPadArt, 'function');
  assert.equal(typeof drawPadArt, 'function');
});
