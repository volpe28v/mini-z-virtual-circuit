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

test('地下駐車場: 90° のコーナーが 12 個連続する (右・左・右・右・左・右・右・左・右・右・左・右)', () => {
  const N = garage.N;
  // 曲がっている区間ごとに、曲がる角度を合計する
  let start = 0;
  while (Math.abs(garage.kappa[start]) > 1 / 1500) start++; // 直線から数え始める
  const turns = [];
  let cur = null;
  for (let c = 0; c < N; c++) {
    const k = garage.kappa[(start + c) % N];
    if (Math.abs(k) > 1 / 1500) {
      if (!cur) cur = 0;
      cur += k * garage.ds;
    } else if (cur !== null) {
      turns.push(cur * DEG);
      cur = null;
    }
  }
  if (cur !== null) turns.push(cur * DEG);
  assert.equal(turns.length, 12, `コーナーの数 ${turns.length}`);
  for (const t of turns) assert.ok(Math.abs(Math.abs(t) - 90) < 12, `90° のコーナー: ${t.toFixed(1)}°`);
  // 右 (+) と左 (−) の並びは、周回の頭の位置によらず、巡回すると 右左右右左右右左右右左右 になる
  const pat = turns.map((t) => (t > 0 ? 'R' : 'L')).join('');
  assert.ok((pat + pat).includes('RLRRLRRLRRLR'), pat);
});

test('地下駐車場: 柱は 5 番の目 (四隅 + 中央) の 5 本で、四隅は十字の切れ込みに、中央は十字の内側にあり、道路に重ならない', () => {
  const pil = garage.course.pillars.map(([x, y]) => [x * garage.course.scale, y * garage.course.scale]);
  assert.equal(pil.length, 5);
  const c = pil[4];
  // 四隅が中央から等距離で、対角に並ぶ (5 番の目)
  const d0 = Math.hypot(pil[0][0] - c[0], pil[0][1] - c[1]);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(Math.hypot(pil[i][0] - c[0], pil[i][1] - c[1]) - d0) < 1e-6);
    assert.ok(Math.abs(Math.abs(pil[i][0] - c[0]) - Math.abs(pil[i][1] - c[1])) < 1e-6, '対角');
  }
  for (const [x, y] of pil.slice(0, 4)) {
    // 四隅の柱は、コースが曲がる円弧の中心に近い (柱をなめるように曲がる): 中心線までの距離 = 曲がりの半径
    let d = Infinity;
    for (let i = 0; i < garage.N; i++) d = Math.min(d, Math.hypot(garage.x[i] - x, garage.y[i] - y));
    assert.ok(d > 175 && d < 215, `四隅の柱と中心線の距離 ${d.toFixed(0)}mm`);
  }
  for (const [x, y] of pil) {
    let d = Infinity;
    for (let i = 0; i < garage.N; i++) d = Math.min(d, Math.hypot(garage.x[i] - x, garage.y[i] - y));
    // 柱 (一辺 58mm) と最大幅 (180mm) の道路が重ならない + 通れる余裕
    assert.ok(d > 29 + 90 + 20, `柱とコースの距離 ${d.toFixed(0)}mm`);
    assert.ok(d < 800, `柱がコースから遠すぎる ${d.toFixed(0)}mm`); // 中央の柱は、十字の内側から 4 つの凹みの角に囲まれる
  }
});

test('地下駐車場: 通路の間隔は 600mm 以上、最小半径は 185mm 以上', () => {
  let minD = Infinity;
  for (let i = 0; i < garage.N; i += 3) {
    for (let j = i + 1; j < garage.N; j += 3) {
      const arc = Math.min(j - i, garage.N - (j - i)) * garage.ds;
      if (arc < 900) continue;
      minD = Math.min(minD, Math.hypot(garage.x[i] - garage.x[j], garage.y[i] - garage.y[j]));
    }
  }
  assert.ok(minD > 600, `minD=${minD}`);
  let minR = Infinity;
  for (let i = 0; i < garage.N; i++) minR = Math.min(minR, 1 / Math.max(1e-9, Math.abs(garage.kappa[i])));
  assert.ok(minR > 185, `minR=${minR}`);
});

test('地下駐車場: 全長は 8〜14m、速度プロファイルは 0.3〜1 で、コーナーで遅くなる', () => {
  assert.ok(garage.length > 8000 && garage.length < 14000, `${garage.length}`);
  let lo = 1;
  let hi = 0;
  for (const u of garage.speedU) {
    lo = Math.min(lo, u);
    hi = Math.max(hi, u);
  }
  assert.ok(lo >= 0.3 - 1e-9 && hi <= 1 + 1e-9 && lo < 0.6 && hi > 0.75, `${lo} ${hi}`);
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
  assert.ok(total > 100, `コーナーでドリフトしている ${total}`);
  assert.ok(agree / total > 0.85, `向きの一致 ${agree}/${total}`);
  assert.ok(maxD > st.maxDrift * 0.6 && maxD <= st.maxDrift * 1.12 * 1.1 + 0.01, `maxD=${maxD}`);
});

test('設定: コースの選択は既定が ridge、不正な値は既定に戻る、保存値は復元される', () => {
  assert.equal(defaults().course, 'ridge');
  assert.equal(sanitize({ course: 'garage' }).course, 'garage');
  assert.equal(sanitize({ course: 'nowhere' }).course, 'ridge');
  assert.equal(sanitize({ course: 5 }).course, 'ridge');
});
