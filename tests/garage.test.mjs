import test from 'node:test';
import assert from 'node:assert/strict';
import { Track, COURSES, COURSE_IDS, wrapAngle } from '../js/track.js';
import { Vehicle } from '../js/vehicle.js';
import { defaults, sanitize } from '../js/settings.js';

const DEG = 180 / Math.PI;
const garage = new Track('garage');

test('コースの一覧: ridge と garage があり、未知の名前は ridge になる', () => {
  assert.deepEqual(COURSE_IDS.sort(), ['garage', 'ridge']);
  assert.equal(new Track('nothing').course.id, 'ridge');
  assert.equal(new Track().course.id, 'ridge');
  assert.equal(garage.course.indoor, true);
  assert.equal(COURSES.ridge.indoor, false);
});

test('地下駐車場: 閉ループで、1 周でちょうど 360° 回る', () => {
  assert.ok(Math.abs(Math.abs(garage.totalTurn) * DEG - 360) < 1, `${garage.totalTurn * DEG}`);
  // 周回の継ぎ目で位置と角度が飛ばない
  const a = garage.at(garage.length - 1);
  const b = garage.at(garage.length + 1);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 3);
  assert.ok(Math.abs(wrapAngle(a.theta - b.theta)) < 0.05);
});

test('地下駐車場: 折り返しは右・左・右・左・右 (S 字の切り返しが続く) で、半円ずつ 5 回', () => {
  const N = garage.N;
  const runs = [];
  let cur = null;
  for (let i = 0; i < N; i++) {
    const k = garage.kappa[i];
    if (Math.abs(k) > 1 / 250) {
      if (!cur) cur = { sign: Math.sign(k), turn: 0 };
      cur.turn += k * garage.ds;
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  const uturns = runs.filter((r) => Math.abs(r.turn) * DEG > 120);
  assert.equal(uturns.length, 5, `折り返しの数 ${uturns.length}`);
  // 周回の頭がたまたま折り返しの途中でないので、順番は 右 → 左 → 右 → 左 → 右 (κ > 0 が右)
  const signs = uturns.map((r) => r.sign);
  for (let i = 1; i < signs.length; i++) assert.notEqual(signs[i], signs[i - 1], '左右が交互');
});

test('地下駐車場: 通路の間隔は 330mm 以上 (幅 180mm の道でも重ならない)、最小半径は 160mm 以上', () => {
  let minD = Infinity;
  for (let i = 0; i < garage.N; i += 3) {
    for (let j = i + 1; j < garage.N; j += 3) {
      const arc = Math.min(j - i, garage.N - (j - i)) * garage.ds;
      if (arc < 900) continue;
      minD = Math.min(minD, Math.hypot(garage.x[i] - garage.x[j], garage.y[i] - garage.y[j]));
    }
  }
  assert.ok(minD > 330, `minD=${minD}`);
  let minR = Infinity;
  for (let i = 0; i < garage.N; i++) minR = Math.min(minR, 1 / Math.max(1e-9, Math.abs(garage.kappa[i])));
  assert.ok(minR > 160, `minR=${minR}`);
});

test('地下駐車場: 全長は 12〜18m、速度プロファイルは 0.3〜1 で、折り返しで遅くなる', () => {
  assert.ok(garage.length > 12000 && garage.length < 18000, `${garage.length}`);
  let lo = 1;
  let hi = 0;
  for (const u of garage.speedU) {
    lo = Math.min(lo, u);
    hi = Math.max(hi, u);
  }
  assert.ok(lo >= 0.3 - 1e-9 && hi <= 1 + 1e-9 && lo < 0.5 && hi > 0.95, `${lo} ${hi}`);
});

test('地下駐車場: 5 周走れて、折り返しで車体はコーナーの内側を向く (ドリフト角の符号 = 曲率の符号)', () => {
  const st = defaults();
  const v = new Vehicle(garage);
  v.reset(0);
  let agree = 0;
  let total = 0;
  let maxD = 0;
  while (v.progress < 5 * garage.length) {
    v.update(1 / 60, st);
    assert.ok(Number.isFinite(v.position.x) && Number.isFinite(v.heading));
    const k = garage.kappaAt(v.progress);
    maxD = Math.max(maxD, Math.abs(v.driftAngle) * DEG);
    if (Math.abs(k) > 1 / 250 && Math.abs(v.driftAngle) * DEG > 8) {
      total++;
      if (Math.sign(v.driftAngle) === Math.sign(k)) agree++;
    }
  }
  assert.ok(total > 100, `折り返しでドリフトしている ${total}`);
  assert.ok(agree / total > 0.85, `向きの一致 ${agree}/${total}`);
  assert.ok(maxD > st.maxDrift * 0.6 && maxD <= st.maxDrift * 1.12 * 1.1 + 0.01, `maxD=${maxD}`);
});

test('設定: コースの選択は既定が ridge、不正な値は既定に戻る、保存値は復元される', () => {
  assert.equal(defaults().course, 'ridge');
  assert.equal(sanitize({ course: 'garage' }).course, 'garage');
  assert.equal(sanitize({ course: 'nowhere' }).course, 'ridge');
  assert.equal(sanitize({ course: 5 }).course, 'ridge');
});
