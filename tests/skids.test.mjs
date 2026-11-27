import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../js/track.js';
import { Vehicle } from '../js/vehicle.js';
import { defaults } from '../js/settings.js';
import { carGeometry } from '../js/camera.js';
import { SkidMarks, KEEP_LAPS } from '../js/skids.js';

const track = new Track();
const DEG = Math.PI / 180;

function fakeVeh(driftDeg, progress = 0, x = 100, y = 200) {
  return { position: { x, y }, heading: 0.4, driftAngle: driftDeg * DEG, progress };
}

// 実際の走行をシミュレーションしながら記録する
function drive(laps, st = defaults(), sk = new SkidMarks(track.length), fps = 60) {
  const v = new Vehicle(track);
  v.reset(0); // 走行距離 0 (S/F ライン) から
  while (v.progress < laps * track.length) v.update(1 / fps, st, (veh) => sk.update(veh, st));
  return { sk, v };
}

const allPts = (sk) => [...sk.chunks, ...sk.open.filter(Boolean)];

test('ドリフト角が最大角の 25% 未満なら痕は付かない', () => {
  const st = defaults(); // 最大 35° → 8.75° 未満
  const sk = new SkidMarks(track.length);
  for (let i = 0; i < 200; i++) sk.update(fakeVeh(8, i * 5, 100 + i * 5), st);
  assert.equal(allPts(sk).length, 0);
});

test('最大ドリフト角 0° では痕は付かない', () => {
  const st = { ...defaults(), maxDrift: 0 };
  const sk = new SkidMarks(track.length);
  for (let i = 0; i < 200; i++) sk.update(fakeVeh(20, i * 5), st);
  assert.equal(allPts(sk).length, 0);
});

test('ドリフト中は左右の後輪の位置に痕が付き、深いほど濃い段階になる', () => {
  const st = defaults();
  const g = carGeometry(st.carLength, st.carWidth);
  const check = (deg, bucket) => {
    const sk = new SkidMarks(track.length);
    const veh = fakeVeh(deg);
    sk.update(veh, st);
    const open = sk.open.filter(Boolean);
    assert.equal(open.length, 2);
    for (const c of open) assert.equal(c.b, bucket, `${deg}° → 段階 ${c.b}`);
    // 後輪の位置: 車体中心から後ろへホイールベースの半分、左右へトレッドの半分
    const fx = Math.cos(veh.heading);
    const fy = Math.sin(veh.heading);
    const lateral = open.map((c) => (c.pts[0] - veh.position.x) * -fy + (c.pts[1] - veh.position.y) * fx).sort((a, b) => a - b);
    assert.ok(Math.abs(lateral[0] + g.track / 2) < 1e-9 && Math.abs(lateral[1] - g.track / 2) < 1e-9);
    const along = (open[0].pts[0] - veh.position.x) * fx + (open[0].pts[1] - veh.position.y) * fy;
    assert.ok(Math.abs(along + g.wheelbase / 2) < 1e-9);
  };
  check(10, 0); // 29%
  check(25, 1); // 71%
  check(30, 2); // 86%
});

test('痕は車両の長さ・幅の設定に追従する', () => {
  const lateralGap = (st) => {
    const sk = new SkidMarks(track.length);
    sk.update(fakeVeh(30), st);
    const [a, b] = sk.open;
    return Math.hypot(a.pts[0] - b.pts[0], a.pts[1] - b.pts[1]);
  };
  assert.ok(Math.abs(lateralGap({ ...defaults(), carWidth: 50 }) - carGeometry(150, 50).track) < 1e-9);
  assert.ok(lateralGap({ ...defaults(), carWidth: 100 }) > lateralGap({ ...defaults(), carWidth: 50 }) + 20);
});

test('実際の走行で、ドリフト中のコーナーにだけ痕が付く', () => {
  const { sk, v } = drive(1);
  const pts = allPts(sk);
  assert.ok(pts.length > 10, `chunks=${pts.length}`);
  // 痕の点はコース近傍 (中心線から 150mm 以内)
  for (const c of pts) {
    for (let i = 0; i < c.pts.length; i += 10) {
      let best = Infinity;
      for (let j = 0; j < track.N; j += 4) best = Math.min(best, Math.hypot(c.pts[i] - track.x[j], c.pts[i + 1] - track.y[j]));
      assert.ok(best < 150, `distance=${best}`);
    }
  }
  // ストレートの中ほど (S/F ライン手前 100〜700mm) には付かない
  for (const c of pts) {
    const toFinish = track.length - (c.s0 % track.length);
    assert.ok(!(toFinish > 100 && toFinish < 700 && c.s1 - c.s0 < 300), `s0=${c.s0}`);
  }
  void v;
});

test('チャンクは連続している (つなぎ目で切れない) し、点の間隔は 5mm 以上', () => {
  const { sk } = drive(2);
  for (const c of allPts(sk)) {
    assert.ok(c.pts.length >= 8 && c.pts.length <= 80 * 2 + 2);
    for (let i = 2; i < c.pts.length; i += 2) {
      const d = Math.hypot(c.pts[i] - c.pts[i - 2], c.pts[i + 1] - c.pts[i - 1]);
      assert.ok(d >= 5 - 1e-6, `spacing=${d}`);
      assert.ok(d < 40, `gap=${d}`); // 飛んでいない
    }
  }
});

test('3 周ぶんだけ残る: 走行距離で 3 周より前の痕は消える', () => {
  const { sk, v } = drive(7);
  const limit = v.progress - KEEP_LAPS * track.length;
  assert.ok(sk.chunks.length > 0);
  for (const c of sk.chunks) assert.ok(c.s1 >= limit - 1e-6, `古い痕が残っている s1=${c.s1} limit=${limit}`);
  // 残っているのは直近の 3 周 + いま走っている周 (周回番号の範囲 ≦ 4 種)
  const laps = new Set(sk.chunks.map((c) => Math.floor(c.s0 / track.length)));
  assert.ok(laps.size <= KEEP_LAPS + 1, `laps=${[...laps]}`);
  assert.ok(laps.size >= KEEP_LAPS, `3 周ぶんは残る laps=${[...laps]}`);
});

test('何周走っても痕の量は増え続けない (4 周と 12 周でほぼ同じ)', () => {
  const total = (sk) => allPts(sk).reduce((n, c) => n + c.pts.length, 0);
  const a = total(drive(4).sk);
  const b = total(drive(12).sk);
  assert.ok(Math.abs(a - b) / a < 0.25, `4周=${a} 12周=${b}`);
});

test('周回の 1 周目〜3 周目の痕が全部残っている (消えるのは 3 周より前だけ)', () => {
  const { sk, v } = drive(3.2);
  // まだ 3 周走っていないので、最初の痕も残っている
  const first = Math.min(...sk.chunks.map((c) => c.s0));
  assert.ok(first < track.length, `最初の周の痕が残る first=${first}`);
  assert.ok(v.progress < KEEP_LAPS * track.length + track.length);
});

test('フレームレート (30 / 60 / 120fps) によらず痕の量はほぼ同じ', () => {
  const total = (fps) => allPts(drive(2, defaults(), new SkidMarks(track.length), fps).sk).reduce((n, c) => n + c.pts.length, 0);
  const a = total(30);
  const b = total(60);
  const c = total(120);
  assert.ok(Math.abs(a - b) / b < 0.05, `${a} ${b}`);
  assert.ok(Math.abs(c - b) / b < 0.05, `${c} ${b}`);
});

test('reset() で全部消え、version が変わる', () => {
  const { sk } = drive(1);
  const v0 = sk.version;
  sk.reset();
  assert.equal(allPts(sk).length, 0);
  assert.ok(sk.version > v0);
});

test('周ごとの変化 (lapVariation): 周ごとに軌跡がずれ、痕が 1 本に重ならない。ずれは小さい', () => {
  const run = (variation) => {
    const st = defaults();
    const sk = new SkidMarks(track.length);
    const v = new Vehicle(track);
    v.lapVariation = variation;
    v.reset(0);
    let maxDrift = 0;
    let maxOff = 0;
    while (v.progress < 3 * track.length) {
      v.update(1 / 60, st, (veh) => sk.update(veh, st));
      maxDrift = Math.max(maxDrift, Math.abs(v.driftAngle) / DEG);
      maxOff = Math.max(maxOff, Math.abs(v.offset));
    }
    return { sk, maxDrift, maxOff };
  };
  // 周 n の痕の、同じコース位置での横位置を比べる: 変化なしなら完全に一致、ありならずれる
  const lateralAt = (sk, lap) => {
    const probe = 7300; // ヘアピン付近
    const out = [];
    for (const c of sk.chunks) {
      if (Math.floor(c.s0 / track.length) !== lap) continue;
      if (c.s0 % track.length > probe || c.s1 % track.length < probe) continue;
      const i = Math.floor(c.pts.length / 4) * 2;
      out.push([c.pts[i], c.pts[i + 1]]);
    }
    return out;
  };
  const still = run(false);
  const varied = run(true);
  const a0 = lateralAt(still.sk, 0)[0];
  const a1 = lateralAt(still.sk, 1)[0];
  const b0 = lateralAt(varied.sk, 0)[0];
  const b1 = lateralAt(varied.sk, 1)[0];
  assert.ok(a0 && a1 && b0 && b1);
  assert.ok(Math.hypot(a0[0] - a1[0], a0[1] - a1[1]) < 1.5, '変化なしなら周ごとに同じ位置');
  assert.ok(Math.hypot(b0[0] - b1[0], b0[1] - b1[1]) > 1.5, '変化ありなら周ごとにずれる');
  // ずれは小さい: ドリフト角は最大角の 1.12×1.1 倍以内、横位置は 道路幅の半分より十分内側
  assert.ok(varied.maxDrift <= defaults().maxDrift * 1.12 * 1.1 + 0.01, `maxDrift=${varied.maxDrift}`);
  assert.ok(varied.maxOff < defaults().trackWidth / 2 - 15, `maxOff=${varied.maxOff}`);
});
