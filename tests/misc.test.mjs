import test from 'node:test';
import assert from 'node:assert/strict';
import { Track, wrapAngle } from '../js/track.js';
import { Vehicle } from '../js/vehicle.js';
import { cameraMatrix, worldToScreen, viewRadiusMm, carGeometry } from '../js/camera.js';
import { simulateMarks } from '../js/marks.js';
import { defaults, sanitize, loadSettings, saveSettings, guessPxPerMm, SCHEMA, STORAGE_KEY } from '../js/settings.js';

test('設定: 既定値はすべて範囲内で、画面実寸の推定がある', () => {
  const d = defaults({ screenWidth: 744, screenHeight: 1133 });
  for (const s of SCHEMA) assert.ok(d[s.key] >= s.min && d[s.key] <= s.max, s.key);
  assert.equal(d.carX, 0.5);
  assert.equal(d.carY, 0.6);
  assert.equal(d.showCar, false);
  assert.equal(d.pxPerMm, 6.42);
  assert.equal(guessPxPerMm(768, 1024), 5.2);
  assert.equal(guessPxPerMm(1200, 800), 5.2);
  assert.equal(guessPxPerMm(390, 844), 3.78);
});

test('設定: 不正値は範囲に収めるか既定に戻す', () => {
  const s = sanitize({ speed: 99999, maxDrift: -5, carX: 'x', showCar: 'yes', pxPerMm: NaN, unknown: 1 });
  assert.equal(s.speed, 1600);
  assert.equal(s.maxDrift, 0);
  assert.equal(s.carX, 0.5);
  assert.equal(s.showCar, false);
  assert.ok(Number.isFinite(s.pxPerMm));
  assert.equal(s.unknown, undefined);
  assert.deepEqual(sanitize(null), defaults());
});

test('設定: コース幅の既定は 119mm。旧既定 (90 / 108mm) のまま保存された値は移行する', () => {
  assert.equal(defaults().trackWidth, 119);
  assert.equal(sanitize({ trackWidth: 90 }).trackWidth, 119); // v1 で既定のまま
  assert.equal(sanitize({ version: 2, trackWidth: 108 }).trackWidth, 119); // v2 で既定のまま
  assert.equal(sanitize({ trackWidth: 100 }).trackWidth, 100); // 自分で変えた値は残す
  assert.equal(sanitize({ version: 3, trackWidth: 108 }).trackWidth, 108); // 新バージョンで 108 を選んだ場合は残す
  assert.equal(sanitize({ trackWidth: 999 }).trackWidth, 180);
});

test('設定: localStorage への保存と復元、壊れた JSON は既定値', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const d = defaults();
  d.speed = 800;
  d.pxPerMm = 5.9;
  d.showCar = true;
  assert.ok(saveSettings(storage, d));
  const r = loadSettings(storage);
  assert.equal(r.speed, 800);
  assert.equal(r.pxPerMm, 5.9);
  assert.equal(r.showCar, true);
  store.set(STORAGE_KEY, '{broken');
  assert.deepEqual(loadSettings(storage), defaults());
  const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.deepEqual(loadSettings(bad), defaults());
  assert.equal(saveSettings(bad, d), false);
});

test('カメラ: 車両はアンカーに固定され、前方が画面の上になる', () => {
  for (const heading of [0, 1, -2.5, Math.PI, 7, -9]) {
    const cam = { px: 123, py: -45, heading, k: 5.2, ax: 372, ay: 680 };
    const c = worldToScreen(cam, cam.px, cam.py);
    assert.ok(Math.abs(c.x - 372) < 1e-9 && Math.abs(c.y - 680) < 1e-9);
    const f = worldToScreen(cam, cam.px + Math.cos(heading) * 100, cam.py + Math.sin(heading) * 100);
    assert.ok(Math.abs(f.x - 372) < 1e-9, `x=${f.x}`);
    assert.ok(Math.abs(f.y - (680 - 100 * 5.2)) < 1e-9, `y=${f.y}`);
  }
});

test('カメラ: 行列 (dpr 倍) と worldToScreen が一致、視野半径が四隅を覆う', () => {
  const cam = { px: 10, py: 20, heading: 0.7, k: 4, ax: 300, ay: 600 };
  const m = cameraMatrix(cam, 2);
  const p = worldToScreen(cam, 33, -8);
  assert.ok(Math.abs(m.a * 33 + m.c * -8 + m.e - 2 * p.x) < 1e-9);
  assert.ok(Math.abs(m.b * 33 + m.d * -8 + m.f - 2 * p.y) < 1e-9);
  const r = viewRadiusMm(cam, 600, 1000);
  assert.ok(r * cam.k >= Math.hypot(300, 600) - 1e-9);
});

test('カメラ: ドリフト中は路面が車体に対して斜めに流れる', () => {
  const track = new Track();
  const st = defaults();
  const v = new Vehicle(track);
  let found = false;
  for (let i = 0; i < 60 * 40 && !found; i++) {
    v.update(1 / 60, st);
    if (Math.abs(v.driftAngle) > (20 * Math.PI) / 180) {
      // 画面上の進行方向 (車体基準) は上から driftAngle だけ傾く。右コーナー(κ>0)→ 鼻が右 → 路面は左へ流れる
      const rel = wrapAngle(v.travelDirection - v.heading);
      assert.ok(Math.abs(rel + v.driftAngle) < 1e-9);
      found = true;
    }
  }
  assert.ok(found);
});

test('タイヤ痕: ドリフト区間にだけ出て、3 段階の濃さがある', () => {
  const track = new Track();
  const m = simulateMarks(track, defaults());
  const total = m.buckets.reduce((n, b) => n + b.length, 0);
  assert.ok(total > 10, `polylines=${total}`);
  assert.ok(m.buckets[2].length > 0 && m.buckets[0].length > 0);
  assert.ok(m.rubber.length > 200);
  // 痕はコースの近く (中心線から 150mm 以内) にある
  const c = {};
  for (const b of m.buckets) for (const pl of b) {
    for (let i = 0; i < pl.length; i += 20) {
      let best = Infinity;
      for (let j = 0; j < track.N; j += 4) best = Math.min(best, Math.hypot(pl[i] - track.x[j], pl[i + 1] - track.y[j]));
      assert.ok(best < 150, `distance=${best}`);
    }
  }
  void c;
  // ドリフト無効なら痕は出ない
  const none = simulateMarks(track, { ...defaults(), maxDrift: 0 });
  assert.equal(none.buckets.reduce((n, b) => n + b.length, 0), 0);
});

test('デバッグ表示の車輪: 車両の長さ・幅に比例し、車体の中に収まる', () => {
  const base = carGeometry(150, 70);
  assert.ok(Math.abs(base.wheelbase - 95) < 1e-9 && Math.abs(base.track - 55) < 1e-9);
  // 長さを 2 倍にするとホイールベースとタイヤの直径が 2 倍、幅は変わらない
  const longer = carGeometry(300, 70);
  assert.ok(Math.abs(longer.wheelbase - 190) < 1e-9 && Math.abs(longer.wheelH - 24) < 1e-9);
  assert.equal(longer.track, base.track);
  assert.equal(longer.wheelW, base.wheelW);
  // 幅を 2 倍にするとトレッドとタイヤの幅が 2 倍、長さ方向は変わらない
  const wider = carGeometry(150, 140);
  assert.ok(Math.abs(wider.track - 110) < 1e-9 && Math.abs(wider.wheelW - 12) < 1e-9);
  assert.equal(wider.wheelbase, base.wheelbase);
  // 設定の範囲全体で、タイヤが車体の外にはみ出さない
  for (const L of [100, 150, 220]) {
    for (const W of [50, 70, 100]) {
      const g = carGeometry(L, W);
      assert.ok(g.track / 2 + g.wheelW / 2 <= W / 2, `L=${L} W=${W} 幅方向`);
      assert.ok(g.wheelbase / 2 + g.wheelH / 2 <= L / 2, `L=${L} W=${W} 長さ方向`);
    }
  }
});
