import test from 'node:test';
import assert from 'node:assert/strict';
import { Track, wrapAngle } from '../js/track.js';

const t = new Track();

test('コースは閉ループで、1 周でちょうど 360° 回る', () => {
  const gap = Math.hypot(t.x[0] - t.x[t.N - 1], t.y[0] - t.y[t.N - 1]);
  assert.ok(gap < t.ds * 1.05, `gap=${gap}`);
  assert.ok(Math.abs(Math.abs(t.totalTurn) - 2 * Math.PI) < 0.02, `turn=${t.totalTurn}`);
});

test('全長は 6〜9m、サンプル間隔は一定', () => {
  assert.ok(t.length > 6000 && t.length < 9000, `len=${t.length}`);
  for (let i = 0; i < t.N; i += 7) {
    const j = (i + 1) % t.N;
    const d = Math.hypot(t.x[j] - t.x[i], t.y[j] - t.y[i]);
    assert.ok(Math.abs(d - t.ds) < 0.2, `i=${i} d=${d}`);
  }
});

test('最小半径は 150mm 以上 (最大コース幅 160mm でも内側が反転しない)', () => {
  let kmax = 0;
  for (const k of t.kappa) kmax = Math.max(kmax, Math.abs(k));
  assert.ok(1 / kmax >= 150, `minR=${1 / kmax}`);
});

test('離れた区間同士が近づきすぎない (縁石・ランオフを含めて 300mm 以上)', () => {
  let minD = Infinity;
  for (let i = 0; i < t.N; i += 3) {
    for (let j = i + 1; j < t.N; j += 3) {
      let d = (j - i) * t.ds;
      d = Math.min(d, t.length - d);
      if (d < 700) continue;
      minD = Math.min(minD, Math.hypot(t.x[i] - t.x[j], t.y[i] - t.y[j]));
    }
  }
  assert.ok(minD >= 300, `minD=${minD}`);
});

test('at() は周回の継ぎ目で連続 (位置・角度が飛ばない)', () => {
  const a = {};
  const b = {};
  for (const off of [0, t.length, 5 * t.length]) {
    t.at(off - 0.5, a);
    t.at(off + 0.5, b);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1.2);
    assert.ok(Math.abs(wrapAngle(b.theta - a.theta)) < 0.01);
  }
  // 周回してもほぼ同じ値
  t.at(123.4, a);
  t.at(123.4 + 7 * t.length, b);
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6);
});

test('速度プロファイルは 0.3〜1、ストレートで 1、ヘアピンで低い', () => {
  for (const u of t.speedU) assert.ok(u >= 0.3 - 1e-9 && u <= 1 + 1e-9);
  assert.ok(Math.max(...t.speedU) > 0.99);
  assert.ok(Math.min(...t.speedU) < 0.55);
  assert.ok(t.speedAt(t.finishS) > 0.95);
});

test('速度プロファイルの加減速は上限内 (進入で減速、脱出で加速)', () => {
  for (let i = 0; i < t.N; i++) {
    const j = (i + 1) % t.N;
    const du2 = t.speedU[j] ** 2 - t.speedU[i] ** 2;
    assert.ok(du2 < 2 * 0.00065 * t.ds * 1.35, `accel i=${i}`);
    assert.ok(-du2 < 2 * 0.0008 * t.ds * 1.35, `brake i=${i}`);
  }
});
