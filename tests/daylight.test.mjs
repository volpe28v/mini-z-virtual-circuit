import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeOfDay, daylightAt, PERIOD } from '../js/daylight.js';
import { defaults, sanitize } from '../js/settings.js';

test('昼 → 夕方 → 夜 → 明け方 → 昼 の順に巡る', () => {
  const t = new TimeOfDay();
  const seq = [];
  for (let i = 0; i < PERIOD * 10; i++) {
    t.update(0.1);
    if (seq.at(-1) !== t.label) seq.push(t.label);
  }
  assert.deepEqual(seq.slice(0, 5), ['昼', '夕方', '夜', '明け方', '昼']);
});

test('dark・warm は 0〜1 で、なめらかに変わる。周期の継ぎ目でも飛ばない', () => {
  let prev = daylightAt(0);
  let maxStep = 0;
  for (let t = 0.05; t < PERIOD * 3; t += 0.05) {
    const a = daylightAt(t);
    assert.ok(a.dark >= 0 && a.dark <= 1 && a.warm >= 0 && a.warm <= 1);
    maxStep = Math.max(maxStep, Math.abs(a.dark - prev.dark), Math.abs(a.warm - prev.warm));
    prev = a;
  }
  assert.ok(maxStep < 0.03, `0.05 秒の変化 ${maxStep}`);
  assert.equal(daylightAt(0).dark, daylightAt(PERIOD).dark);
});

test('昼は暗さ 0、夜は暗さ 1、夕焼けでは色味 (warm) が最大', () => {
  assert.equal(daylightAt(30).dark, 0);
  assert.equal(daylightAt(150).dark, 1);
  assert.equal(daylightAt(85).warm, 1);
  assert.equal(daylightAt(150).warm, 0);
});

test('フレームレートによらず同じ時刻なら同じ明るさ', () => {
  const run = (fps) => {
    const t = new TimeOfDay();
    for (let i = 0; i < 100 * fps; i++) t.update(1 / fps);
    return t.dark;
  };
  assert.ok(Math.abs(run(30) - run(120)) < 1e-6);
});

test('設定: 時間帯の自動変化は既定で ON、夜の暗さは 0〜1 に補正される', () => {
  assert.equal(defaults().autoTime, true);
  assert.equal(sanitize({ night: 9 }).night, 1);
  assert.equal(sanitize({ autoTime: false }).autoTime, false);
});
