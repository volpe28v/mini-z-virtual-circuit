import test from 'node:test';
import assert from 'node:assert/strict';
import { Track, wrapAngle } from '../js/track.js';
import { Vehicle } from '../js/vehicle.js';
import { defaults } from '../js/settings.js';

const track = new Track();
const st = defaults();
const DEG = 180 / Math.PI;

function run(laps, settings = st, fps = 60) {
  const v = new Vehicle(track);
  const dt = 1 / fps;
  const log = [];
  const end = laps * track.length;
  while (v.progress < end) {
    v.update(dt, settings);
    log.push({
      s: v.progress,
      x: v.position.x,
      y: v.position.y,
      h: v.heading,
      td: v.travelDirection,
      d: v.driftAngle,
      v: v.speed,
      k: track.kappaAt(v.progress),
    });
  }
  return log;
}

const log = run(12);

test('12 周走れて、周回の継ぎ目で位置が飛ばない', () => {
  assert.ok(log.at(-1).s >= 12 * track.length);
  let maxJump = 0;
  for (let i = 1; i < log.length; i++) {
    maxJump = Math.max(maxJump, Math.hypot(log[i].x - log[i - 1].x, log[i].y - log[i - 1].y));
  }
  // 1 フレームの移動量は 最高速 × dt 程度 (600mm/s → 10mm)
  assert.ok(maxJump < 12, `maxJump=${maxJump}`);
});

test('車体の向きは 1 フレームで急に回らない (継ぎ目含む)', () => {
  let maxStep = 0;
  for (let i = 1; i < log.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(wrapAngle(log[i].h - log[i - 1].h)) * DEG);
  }
  // 急なヘアピンでは、進行方向の回転 (約 150°/s) とドリフト角の振り返しが重なる
  assert.ok(maxStep < 3.5, `maxStep=${maxStep}°/frame`);
});

test('ドリフト角は最大角を超えず、変化も滑らか', () => {
  let maxAbs = 0;
  let maxStep = 0;
  for (let i = 1; i < log.length; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(log[i].d) * DEG);
    maxStep = Math.max(maxStep, Math.abs(log[i].d - log[i - 1].d) * DEG);
  }
  assert.ok(maxAbs <= st.maxDrift * 1.12 + 0.01, `maxAbs=${maxAbs}`);
  assert.ok(maxAbs > st.maxDrift * 0.6, `ヘアピンで十分に深くドリフトする: ${maxAbs}`);
  assert.ok(maxStep < 1.8, `1 フレームの変化 ${maxStep}°`);
});

test('車体は旋回方向の内側を向く (角度の符号 = 曲率の符号)', () => {
  let agree = 0;
  let total = 0;
  for (const p of log) {
    if (Math.abs(p.k) > 1 / 300 && Math.abs(p.d) > 5 / DEG) {
      total++;
      if (Math.sign(p.d) === Math.sign(p.k)) agree++;
    }
  }
  assert.ok(total > 200);
  assert.ok(agree / total > 0.9, `agree=${agree}/${total}`);
});

test('ストレートではグリップが戻る (角度がほぼ 0)', () => {
  // メインストレート (S/F ラインの手前 700mm 以内)
  const straight = log.filter((p) => Math.abs(p.k) < 1 / 5000 && track.length - (p.s % track.length) < 700 && track.length - (p.s % track.length) > 100);
  assert.ok(straight.length > 50);
  const worst = Math.max(...straight.map((p) => Math.abs(p.d) * DEG));
  assert.ok(worst < 4, `worst=${worst}°`);
});

test('S 字 (シケイン) で左右のドリフトが反転する', () => {
  const lap = log.filter((p) => p.s >= 5 * track.length && p.s < 6 * track.length);
  // 符号が + から − (または逆) に切り替わった回数。ヘアピン等を含め 1 周で複数回ある
  let flips = 0;
  let last = 0;
  for (const p of lap) {
    const sg = Math.abs(p.d) > 6 / DEG ? Math.sign(p.d) : 0;
    if (sg !== 0) {
      if (last !== 0 && sg !== last) flips++;
      last = sg;
    }
  }
  assert.ok(flips >= 2, `flips=${flips}`);
});

test('速度は連続で、ストレート > ヘアピン', () => {
  let maxDv = 0;
  for (let i = 1; i < log.length; i++) maxDv = Math.max(maxDv, Math.abs(log[i].v - log[i - 1].v));
  assert.ok(maxDv < 8, `maxDv=${maxDv}`);
  const vs = log.map((p) => p.v);
  assert.ok(Math.max(...vs) > 0.95 * st.speed);
  assert.ok(Math.min(...vs) < 0.6 * st.speed);
});

test('進行方向 = 車体の向き − ドリフト角 (独立に管理)', () => {
  for (const p of log.filter((_, i) => i % 50 === 0)) {
    assert.ok(Math.abs(wrapAngle(p.h - p.td - p.d)) < 1e-9);
  }
});

test('フレームレート (30/60/120fps) によらず同じ軌跡 (時間ベース)', () => {
  const at = (fps) => {
    const v = new Vehicle(track);
    for (let i = 0; i < 10 * fps; i++) v.update(1 / fps, st);
    return v;
  };
  const a = at(30);
  const b = at(60);
  const c = at(120);
  assert.ok(Math.abs(a.progress - b.progress) < 3, `${a.progress} ${b.progress}`);
  assert.ok(Math.abs(b.progress - c.progress) < 3);
});

test('ドリフト 0° / 強度 0 ではドリフトしない', () => {
  const l = run(1, { ...st, maxDrift: 0 });
  assert.ok(Math.max(...l.map((p) => Math.abs(p.d))) < 1e-9);
  const l2 = run(1, { ...st, driftStrength: 0 });
  assert.ok(Math.max(...l2.map((p) => Math.abs(p.d))) < 1e-6);
});

test('速度設定を変えても走行できる (最小/最大)', () => {
  for (const speed of [150, 1600]) {
    const l = run(2, { ...st, speed });
    assert.ok(l.at(-1).s >= 2 * track.length);
    const maxJump = Math.max(...l.slice(1).map((p, i) => Math.hypot(p.x - l[i].x, p.y - l[i].y)));
    assert.ok(maxJump < speed / 60 + 2);
  }
});

test('フェイント: コーナー手前でコーナーと逆へ車体を振ってから、切り込む', () => {
  const s = { ...defaults(), feint: 1 };
  const v = new Vehicle(track);
  v.reset(0);
  const dt = 1 / 120;
  let feints = 0;
  let prevSign = 0;
  let inFeint = false;
  let ok = 0;
  while (v.progress < 2 * track.length) {
    v.update(dt, s);
    // 先のコーナー (急) に向かう直線で、コーナーと逆向きの角度が 5° 以上出たらフェイントとみなす
    if (v._feintW > 0.5) {
      const dir = Math.sign(track.kappaAt(v.progress + v.speed * 0.8));
      if (v.driftAngle * dir < -(5 / DEG)) inFeint = true;
      prevSign = dir;
    } else if (inFeint && Math.abs(v.driftAngle) > 8 / DEG && v.driftAngle * prevSign > 0) {
      ok++;
      feints++;
      inFeint = false;
    }
  }
  assert.ok(feints >= 4, `フェイント → 切り込みの回数 ${feints}`);
  assert.ok(ok >= 4);
});

test('フェイント 0 なら従来どおり (逆向きに振らない)', () => {
  const s = { ...defaults(), feint: 0 };
  const v = new Vehicle(track);
  v.reset(0);
  let wrong = 0;
  while (v.progress < track.length) {
    v.update(1 / 120, s);
    if (v._feintW !== 0) wrong++;
  }
  assert.equal(wrong, 0);
});

test('フェイントでも角度の上限と滑らかさを守る', () => {
  const s = { ...defaults(), feint: 2 };
  const v = new Vehicle(track);
  v.reset(0);
  let maxAbs = 0;
  let maxStep = 0;
  let prev = v.heading;
  while (v.progress < 3 * track.length) {
    v.update(1 / 60, s);
    maxAbs = Math.max(maxAbs, Math.abs(v.driftAngle) * DEG);
    maxStep = Math.max(maxStep, Math.abs(wrapAngle(v.heading - prev)) * DEG);
    prev = v.heading;
  }
  assert.ok(maxAbs <= s.maxDrift * 1.12 * 1.1 + 0.01, `maxAbs=${maxAbs}`);
  assert.ok(maxStep < 3.5, `maxStep=${maxStep}`);
});

test('引きずり: コーナーを抜けた直線でも角度がしばらく残り、ゆっくり戻る', () => {
  // コーナー出口から 250mm 走った時点の、同じ向きの角度の平均 (全コーナー)
  const exitAngle = (carry) => {
    const s = { ...defaults(), carry, feint: 0 };
    const v = new Vehicle(track);
    v.reset(0);
    let peak = 0;
    let since = -1;
    const samples = [];
    while (v.progress < 2 * track.length) {
      v.update(1 / 120, s);
      const k = Math.abs(track.kappaAt(v.progress));
      if (k > 1 / 300) {
        peak = Math.abs(v.driftAngle);
        since = v.progress;
      } else if (since >= 0 && peak > 20 / DEG && v.progress - since > 250) {
        samples.push((Math.abs(v.driftAngle) * Math.sign(track.kappaAt(since))) / peak);
        since = -1;
      }
    }
    return samples.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, samples.length);
  };
  const off = exitAngle(0);
  const on = exitAngle(1);
  assert.ok(on > off + 0.1, `引きずりあり ${on.toFixed(2)} > なし ${off.toFixed(2)}`);
});

test('引きずり: 逆向きの次のコーナーにはすぐ切り替わり、角度の上限も守る', () => {
  const s = { ...defaults(), carry: 2, feint: 1 };
  const v = new Vehicle(track);
  v.reset(0);
  let maxAbs = 0;
  let maxStep = 0;
  let prev = v.heading;
  while (v.progress < 3 * track.length) {
    v.update(1 / 60, s);
    maxAbs = Math.max(maxAbs, Math.abs(v.driftAngle) * DEG);
    maxStep = Math.max(maxStep, Math.abs(wrapAngle(v.heading - prev)) * DEG);
    prev = v.heading;
  }
  assert.ok(maxAbs <= s.maxDrift * 1.12 * 1.1 + 0.01, `maxAbs=${maxAbs}`);
  assert.ok(maxStep < 3.5, `maxStep=${maxStep}`);
});

test('ライン取りのふらつき: 左右に動き、周ごとに違い、道幅からはみ出さない。0 なら従来どおり', () => {
  const measure = (wander, lap) => {
    const s = { ...defaults(), wander };
    const v = new Vehicle(track);
    v.reset(0);
    let sum = 0;
    let n = 0;
    let mx = 0;
    let pos = -1;
    const probe = [];
    while (v.progress < (lap + 1) * track.length) {
      v.update(1 / 60, s);
      if (v.progress >= lap * track.length) {
        sum += v.offset * v.offset;
        n++;
        mx = Math.max(mx, Math.abs(v.offset));
        const k = Math.floor((v.progress % track.length) / 400);
        if (k !== pos) {
          pos = k;
          probe.push(v.offset);
        }
      }
    }
    return { rms: Math.sqrt(sum / n), mx, probe };
  };
  const off = measure(0, 1);
  const on1 = measure(1, 1);
  const on2 = measure(1, 2);
  assert.ok(on1.rms > off.rms + 2, `rms ${on1.rms.toFixed(1)} > ${off.rms.toFixed(1)}`);
  let diff = 0;
  for (let i = 0; i < Math.min(on1.probe.length, on2.probe.length); i++) diff += Math.abs(on1.probe[i] - on2.probe[i]);
  assert.ok(diff / on1.probe.length > 4, `周ごとの違い ${(diff / on1.probe.length).toFixed(1)}mm`);
  const wide = measure(2, 1);
  assert.ok(wide.mx < defaults().trackWidth / 2 - 15, `はみ出し ${wide.mx}`);
});

test('ウェット路面: グリップが低く、角度が深く長く滑る。0 ならドライと同じ。上限は守る', () => {
  const peakAndExit = (wet) => {
    const s = { ...defaults(), wet, wander: 0, feint: 0 };
    const v = new Vehicle(track);
    v.reset(0);
    let peak = 0;
    let exit = 0;
    let n = 0;
    let since = -1;
    while (v.progress < 2 * track.length) {
      v.update(1 / 120, s);
      peak = Math.max(peak, Math.abs(v.driftAngle));
      const k = Math.abs(track.kappaAt(v.progress));
      if (k > 1 / 300) since = v.progress;
      else if (since >= 0 && v.progress - since > 300) {
        exit += Math.abs(v.driftAngle);
        n++;
        since = -1;
      }
    }
    return { peak: peak * DEG, exit: exit / Math.max(1, n) };
  };
  const dry = peakAndExit(0);
  const wet = peakAndExit(1);
  assert.ok(wet.peak > dry.peak, `${wet.peak} > ${dry.peak}`);
  assert.ok(wet.exit > dry.exit, '出口でも長く滑る');
  assert.ok(wet.peak <= defaults().maxDrift * 1.12 * 1.1 * 1.15 + 0.01);
  assert.equal(peakAndExit(0).peak, dry.peak);
});
