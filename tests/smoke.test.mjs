import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../js/track.js';
import { Vehicle } from '../js/vehicle.js';
import { defaults } from '../js/settings.js';
import { carGeometry } from '../js/camera.js';
import { SmokeSystem, MAX_PARTICLES, MAX_AMOUNT, smokeSize, smokeAlpha } from '../js/smoke.js';

const track = new Track();
const DEG = Math.PI / 180;

// 位置・向き・ドリフト角を指定できる簡易の車両
function fakeVeh(driftDeg, extra = {}) {
  return {
    position: { x: 100, y: 200 },
    velocity: { x: 400, y: 0 },
    heading: 0.3,
    driftAngle: driftDeg * DEG,
    speed: 400,
    ...extra,
  };
}

function simulate(laps, st, fps = 60, onFrame) {
  const v = new Vehicle(track);
  const s = new SmokeSystem();
  const dt = 1 / fps;
  const log = [];
  while (v.progress < laps * track.length) {
    v.update(dt, st);
    s.update(dt, v, st);
    log.push({ count: s.count, beta: Math.abs(v.driftAngle) / DEG });
    if (onFrame) onFrame(v, s);
  }
  return { s, log };
}

test('ドリフト角がしきい値 (15°) 未満なら煙は出ない', () => {
  const st = defaults();
  const s = new SmokeSystem();
  for (let i = 0; i < 120; i++) s.update(1 / 60, fakeVeh(14), st);
  assert.equal(s.count, 0);
});

test('しきい値を超えると出て、角度が深いほど多く出る', () => {
  const st = defaults();
  const shallow = new SmokeSystem();
  const deep = new SmokeSystem();
  for (let i = 0; i < 60; i++) {
    shallow.update(1 / 60, fakeVeh(18), st);
    deep.update(1 / 60, fakeVeh(35), st);
  }
  assert.ok(shallow.count > 0);
  assert.ok(deep.count > shallow.count, `deep=${deep.count} shallow=${shallow.count}`);
});

test('量 0 または最大ドリフト角 0 では出ない', () => {
  const s = new SmokeSystem();
  for (let i = 0; i < 60; i++) s.update(1 / 60, fakeVeh(30), { ...defaults(), smoke: 0 });
  assert.equal(s.count, 0);
  for (let i = 0; i < 60; i++) s.update(1 / 60, fakeVeh(30), { ...defaults(), maxDrift: 0 });
  assert.equal(s.count, 0);
});

test('粒は後輪の位置から出て、車体の外側へ広がる', () => {
  const st = defaults();
  const veh = fakeVeh(30, { velocity: { x: 0, y: 0 }, speed: 0 });
  const s = new SmokeSystem();
  s.update(0.1, veh, { ...st, speed: 600 }); // 出た直後 (まだ動いていない) の粒を調べる
  assert.ok(s.count > 0);
  const g = carGeometry(st.carLength, st.carWidth);
  const fx = Math.cos(veh.heading);
  const fy = Math.sin(veh.heading);
  const rx = -fy;
  const ry = fx;
  for (let i = 0; i < s.cap; i++) {
    if (!s.alive(i)) continue;
    // 車体座標へ変換: 前後 (f)・左右 (r)
    const dx = s.x[i] - veh.position.x;
    const dy = s.y[i] - veh.position.y;
    const along = dx * fx + dy * fy;
    const lateral = dx * rx + dy * ry;
    assert.ok(Math.abs(along + g.wheelbase / 2) < 3, `前後 ${along}`); // 後輪 (車体中心から後ろへ ホイールベースの半分)
    assert.ok(Math.abs(Math.abs(lateral) - g.track / 2) < 3, `左右 ${lateral}`);
    // 外側へ流れる速度 (左右方向) の符号が、出た側と一致
    const vlat = s.vx[i] * rx + s.vy[i] * ry;
    assert.equal(Math.sign(vlat), Math.sign(lateral));
  }
});

test('車両の長さ・幅の設定に合わせて発生位置が変わる', () => {
  const veh = fakeVeh(30, { velocity: { x: 0, y: 0 }, speed: 0 });
  const dist = (st) => {
    const s = new SmokeSystem();
    s.update(0.1, veh, st);
    let n = 0;
    let sum = 0;
    for (let i = 0; i < s.cap; i++) if (s.alive(i)) { sum += Math.hypot(s.x[i] - veh.position.x, s.y[i] - veh.position.y); n++; }
    return sum / n;
  };
  assert.ok(dist({ ...defaults(), carLength: 220 }) > dist({ ...defaults(), carLength: 100 }) + 20);
});

test('粒は寿命で消え、大きくなりながら薄くなる。上限を超えない', () => {
  const st = defaults();
  const s = new SmokeSystem();
  let prevSize = -1;
  for (let i = 0; i < 600; i++) {
    s.update(1 / 60, fakeVeh(35), st);
    assert.ok(s.count <= MAX_PARTICLES);
  }
  assert.ok(s.count > 0);
  // 発生を止めたら、寿命 (最長 約 3 秒) のうちに全部消える
  for (let i = 0; i < 60 * 3; i++) s.update(1 / 60, fakeVeh(0), st);
  assert.equal(s.count, 0);
  // 1 粒の見た目: 大きくなり、不透明度は 0〜上限
  const one = new SmokeSystem();
  one.update(1 / 30, fakeVeh(35), st);
  const k = [...Array(one.cap).keys()].find((i) => one.alive(i));
  const sizes = [];
  for (let step = 0; step < 10; step++) {
    one.age[k] = (one.life[k] * step) / 10;
    sizes.push(smokeSize(one, k));
    const a = smokeAlpha(one, k);
    assert.ok(a >= 0 && a <= one.a0[k] + 1e-9, `alpha=${a}`);
    if (prevSize >= 0) assert.ok(sizes.at(-1) >= prevSize - 1e-9);
    prevSize = sizes.at(-1);
  }
  assert.ok(sizes.at(-1) > sizes[0] * 2);
});

test('フレームレート (30 / 60 / 120fps) によらず発生量はほぼ同じ', () => {
  const st = defaults();
  // 出方にはランダムなむらがあるので、種を変えて合計で比べる
  const total = (fps) => {
    let spawned = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const s = new SmokeSystem(seed);
      for (let i = 0; i < 4 * fps; i++) {
        const h0 = s.head;
        s.update(1 / fps, fakeVeh(30), st);
        spawned += (s.head - h0 + s.cap) % s.cap;
      }
    }
    return spawned;
  };
  const a = total(30);
  const b = total(60);
  const c = total(120);
  assert.ok(Math.abs(a - b) / b < 0.1, `${a} ${b}`);
  assert.ok(Math.abs(c - b) / b < 0.1, `${c} ${b}`);
});

test('12 周走行: 煙はドリフト中だけ出て、ストレートでは消える', () => {
  const st = defaults();
  const { log } = simulate(3, st);
  const withSmoke = log.filter((f) => f.count > 0).length;
  assert.ok(withSmoke > log.length * 0.2, '1 周のかなりの区間で煙がある');
  assert.ok(withSmoke < log.length, 'ずっと出ているわけではない');
  // しきい値未満が 3 秒以上続いたあとは煙が 0 になる
  let calm = 0;
  let checked = 0;
  for (const f of log) {
    calm = f.beta < 15 ? calm + 1 : 0;
    if (calm > 60 * 3) {
      assert.equal(f.count, 0);
      checked++;
    }
  }
  assert.ok(checked > 0, 'ストレートで煙が消えることを確認できた');
});

test('同じ種 (seed) なら同じ煙 (再現性)', () => {
  const st = defaults();
  const run = () => {
    const s = new SmokeSystem(3);
    for (let i = 0; i < 90; i++) s.update(1 / 60, fakeVeh(30), st);
    return Array.from(s.x.slice(0, 20));
  };
  assert.deepEqual(run(), run());
});

test('量を上げるほど増える (上限 3 まで)。粒数と不透明度は上限内', () => {
  const run = (amount, deg = 35) => {
    const s = new SmokeSystem();
    let peak = 0;
    let maxA = 0;
    for (let i = 0; i < 600; i++) {
      s.update(1 / 60, fakeVeh(deg), { ...defaults(), smoke: amount });
      peak = Math.max(peak, s.count);
      for (let k = 0; k < s.cap; k++) if (s.alive(k)) maxA = Math.max(maxA, s.a0[k]);
    }
    return { peak, maxA };
  };
  const r1 = run(1);
  const r15 = run(1.5);
  const r3 = run(3);
  // 粒数の比較は、上限 (MAX_PARTICLES) に張り付かない浅めのドリフトで行う
  const m1 = run(1, 18).peak;
  const m15 = run(1.5, 18).peak;
  const m3 = run(3, 18).peak;
  assert.ok(m15 > m1, `${m15} ${m1}`);
  assert.ok(m3 > m15 * 1.3, `量 3 は 1.5 よりはっきり多い: ${m3} ${m15}`);
  assert.ok(r3.peak <= MAX_PARTICLES);
  assert.ok(r3.maxA <= 0.85 + 1e-6 && r3.maxA >= r15.maxA); // 最深のドリフトでは 1.5 の時点で上限 (0.85) に達する
  // 上限を超える値を入れても、上限 (3) と同じ
  assert.equal(run(5).peak, r3.peak);
  assert.equal(MAX_AMOUNT, 3);
});

test('ドリフトが長く続くほど煙が増える', () => {
  const st = defaults();
  const rate = (seconds) => {
    let spawned = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const s = new SmokeSystem(seed);
      const dt = 1 / 60;
      for (let i = 0; i < seconds * 60; i++) s.update(dt, fakeVeh(30), st); // 助走
      for (let i = 0; i < 60; i++) {
        const h0 = s.head;
        s.update(dt, fakeVeh(30), st);
        spawned += (s.head - h0 + s.cap) % s.cap;
      }
    }
    return spawned;
  };
  const start = rate(0);
  const long = rate(2);
  assert.ok(long > start * 1.5, `始め ${start} → 2 秒後 ${long}`);
});

test('煙の出方にランダムなむらがある (時間ごとの量が一定でない)。種が同じなら再現する', () => {
  const st = defaults();
  const bins = (seed) => {
    const s = new SmokeSystem(seed);
    const out = [];
    for (let b = 0; b < 20; b++) {
      let n = 0;
      for (let i = 0; i < 12; i++) {
        const h0 = s.head;
        s.update(1 / 60, fakeVeh(30), st);
        n += (s.head - h0 + s.cap) % s.cap;
      }
      out.push(n);
    }
    return out.slice(10); // 立ち上がり後
  };
  const a = bins(3);
  assert.ok(Math.max(...a) - Math.min(...a) >= 3, `むらが小さい: ${a}`);
  assert.deepEqual(bins(3), a);
});

test('ドリフトが終われば持ち越した時間は消える', () => {
  const s = new SmokeSystem();
  for (let i = 0; i < 180; i++) s.update(1 / 60, fakeVeh(30), defaults());
  assert.ok(s.driftTime > 2.5);
  for (let i = 0; i < 300; i++) s.update(1 / 60, fakeVeh(0), defaults());
  assert.ok(s.driftTime < 0.05);
});
