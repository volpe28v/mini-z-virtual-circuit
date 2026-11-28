import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../js/track.js';
import { Vehicle } from '../js/vehicle.js';
import { defaults, sanitize } from '../js/settings.js';
import { SkidMarks } from '../js/skids.js';
import { SmokeSystem } from '../js/smoke.js';

const track = new Track();
const garage = new Track('garage');
const DEG = Math.PI / 180;

// 周回を走って、各ステップの状態を記録する
function run(st, laps = 1.2, track0 = track) {
  const v = new Vehicle(track0);
  v.reset(0);
  const log = [];
  while (v.progress < laps * track0.length) {
    v.update(1 / 120, st, (veh) => log.push({ s: veh.progress, air: veh.air, rate: veh.driftRate, ang: veh.driftAngle, kick: veh.landKick }));
  }
  return { v, log };
}

test('ジャンプ台は ridge コースの ⑦ と ⑧ の間 (緩い斜めの直線の途中) にある', () => {
  assert.equal(track.jumps.length, 1);
  const s = track.jumps[0].s;
  // 踏み切りの前後 200mm は直線 (半径 1500mm 以上)、⑦ の出口から ⑧ の入口までのあいだ
  for (const d of [-100, 0, 200]) assert.ok(Math.abs(track.kappaAt(s + d)) < 1 / 1500, `d=${d}`);
  const c = track.at(s);
  const px = [c.x / 6.5, c.y / 6.5];
  assert.ok(px[0] > 262 && px[0] < 325 && px[1] > 238 && px[1] < 345, `px=${px}`);
  assert.equal(garage.jumps.length, 0); // 駐車場には無い
});

test('1 周に 1 回だけ飛び、約 0.7 秒で着地する。着地の瞬間は 1 ステップだけ', () => {
  const { log } = run(defaults());
  const airSteps = log.filter((e) => e.air > 0);
  assert.ok(airSteps.length > 0.6 * 120 && airSteps.length < 0.8 * 120, `air steps=${airSteps.length}`);
  assert.equal(log.filter((e) => e.kick > 0).length, 1);
  assert.ok(Math.max(...log.map((e) => e.air)) > 0.99);
  // 浮いているあいだに、周回の別の場所では浮かない
  const s = track.jumps[0].s;
  for (const e of airSteps) assert.ok(e.s > s && e.s < s + 700, `s=${e.s - s}`);
});

test('空中ではドリフト角が変わらない (グリップが効かない)。着地で少し振られる', () => {
  const { log } = run(defaults());
  const air = log.filter((e) => e.air > 0);
  const a0 = air[0].ang;
  for (const e of air) assert.ok(Math.abs(e.ang - a0) < 3 * DEG, `${e.ang / DEG}`); // 慣性だけで動く
  const i = log.findIndex((e) => e.kick > 0);
  assert.ok(Math.abs(log[i].rate) > 20 * DEG, 'rate after landing');
});

test('ジャンプ 0 なら飛ばない', () => {
  const { log } = run({ ...defaults(), jump: 0 });
  assert.ok(log.every((e) => e.air === 0 && e.kick === 0));
});

test('空中はタイヤ痕が付かず、煙も出ない。着地で土煙が一気に出る', () => {
  const st = defaults();
  const sk = new SkidMarks(track.length);
  const sm = new SmokeSystem(3);
  const v = new Vehicle(track);
  v.reset(0);
  let airSmokeMax = 0;
  let landBurst = 0;
  let prevCount = 0;
  let lastLand = 0;
  while (v.progress < 1.2 * track.length) {
    v.update(1 / 60, st, (veh) => {
      sk.update(veh, st);
      // 空中は、記録中の痕が無い
      if (veh.air > 0) assert.ok(sk.open.every((o) => !o));
    });
    const before = sm.count;
    sm.update(1 / 60, v, st);
    if (v.air > 0) airSmokeMax = Math.max(airSmokeMax, sm.count - before > 0 ? 1 : 0);
    if (v.landings !== lastLand) {
      lastLand = v.landings;
      landBurst = sm.count - prevCount;
    }
    prevCount = sm.count;
  }
  assert.equal(airSmokeMax, 0, '空中に新しい粒が出ていない');
  assert.ok(landBurst >= 8, `着地の土煙 ${landBurst}`);
});

test('ジャンプしても角度の上限と滑らかさを守り、周回して戻ってくる', () => {
  const st = defaults();
  const { v, log } = run(st, 3);
  const lim = st.maxDrift * 1.12 * 1.1 * DEG + 1e-6;
  for (const e of log) assert.ok(Math.abs(e.ang) <= lim, `ang=${e.ang / DEG}`);
  for (let i = 1; i < log.length; i++) assert.ok(Math.abs(log[i].ang - log[i - 1].ang) < 3.5 * DEG, `step ${i}`);
  assert.ok(Math.abs(v.offset) < st.trackWidth / 2);
  assert.equal(log.filter((e) => e.kick > 0).length, 3); // 3 周で 3 回
});

test('フレームレートによらず同じ場所で飛ぶ', () => {
  const at = (fps) => {
    const v = new Vehicle(track);
    v.reset(0);
    let s = null;
    while (v.progress < track.length) {
      v.update(1 / fps, defaults());
      if (v.air > 0 && s === null) s = v.progress;
    }
    return s;
  };
  assert.ok(Math.abs(at(30) - at(120)) < 30);
});

test('設定: ジャンプは既定で 1、範囲外は丸められる', () => {
  assert.equal(defaults().jump, 1);
  assert.equal(sanitize({ jump: 9 }).jump, 1.5);
  assert.equal(sanitize({ jump: -1 }).jump, 0);
});
