import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../js/track.js';
import { Vehicle } from '../js/vehicle.js';
import { defaults } from '../js/settings.js';
import {
  EngineModel,
  squealLevel,
  firingHz,
  IDLE_RPM,
  REDLINE_RPM,
  GEAR_RPM_PER_KMH,
  VIRTUAL_TOP_KMH,
} from '../js/enginesound.js';

const track = new Track();
const DEG = Math.PI / 180;

// 実際の走行で回し、毎フレームのモデルの状態を記録する
function drive(laps, st = defaults(), fps = 60) {
  const v = new Vehicle(track);
  v.reset(0);
  const m = new EngineModel();
  const log = [];
  const dt = 1 / fps;
  let t = 0;
  while (v.progress < laps * track.length) {
    v.update(dt, st);
    m.update(dt, v.speed, st.speed);
    t += dt;
    log.push({ t, rpm: m.rpm, gear: m.gear, throttle: m.throttle, kmh: m.kmh, shift: m.shift, speed: v.speed });
  }
  return log;
}

test('停止中はアイドリング (900rpm)、1 速', () => {
  const m = new EngineModel();
  for (let i = 0; i < 60; i++) m.update(1 / 60, 0, 600);
  assert.ok(Math.abs(m.rpm - IDLE_RPM) < 5, `rpm=${m.rpm}`);
  assert.equal(m.gear, 0);
});

test('速度に対して、回転数が適正な範囲 (4000〜7000) に入るギアを選ぶ', () => {
  for (const frac of [0.2, 0.35, 0.5, 0.7, 0.9, 1.0]) {
    const m = new EngineModel();
    m.update(1 / 60, 600 * frac, 600);
    const rpm = m.kmh * GEAR_RPM_PER_KMH[m.gear];
    if (m.kmh * GEAR_RPM_PER_KMH[0] >= 4000) assert.ok(rpm >= 4000 && rpm <= 7000 + 1, `frac=${frac} rpm=${rpm}`);
  }
  // 最高速は 6 速
  const top = new EngineModel();
  top.update(1 / 60, 600, 600);
  assert.equal(top.gear, 5);
  assert.ok(Math.abs(top.kmh - VIRTUAL_TOP_KMH) < 1e-9);
});

test('走行中の回転数は常にアイドル〜レッドゾーンの範囲内', () => {
  const log = drive(3);
  for (const f of log) assert.ok(f.rpm >= IDLE_RPM * 0.9 - 1e-6 && f.rpm <= REDLINE_RPM + 800 + 1e-6, `rpm=${f.rpm}`);
  const rpms = log.map((f) => f.rpm);
  assert.ok(Math.max(...rpms) > 6000, 'しっかり回る');
  assert.ok(Math.min(...rpms) < 5200, 'コーナーで回転が落ちる');
});

test('1 周でシフトアップ・ダウンが起き、複数のギアを使い、変速は 0.4 秒以上あく', () => {
  const log = drive(2);
  const shifts = log.filter((f) => f.shift);
  const ups = shifts.filter((f) => f.shift === 'up').length;
  const downs = shifts.filter((f) => f.shift === 'down').length;
  assert.ok(ups >= 4 && downs >= 4, `up=${ups} down=${downs}`);
  assert.ok(shifts.length / 2 < 40, `変速が多すぎる 1 周 ${shifts.length / 2} 回`);
  assert.ok(new Set(log.map((f) => f.gear)).size >= 3, '3 つ以上のギアを使う');
  for (let i = 1; i < shifts.length; i++) assert.ok(shifts[i].t - shifts[i - 1].t >= 0.4 - 1e-6, `変速の間隔 ${shifts[i].t - shifts[i - 1].t}`);
});

test('シフトアップで回転数が落ち、シフトダウンで跳ねる (ブリッピング)', () => {
  const log = drive(2);
  const afterUp = [];
  const afterDown = [];
  for (let i = 1; i < log.length - 12; i++) {
    if (log[i].shift === 'up') afterUp.push(log[i - 1].rpm - log[i + 3].rpm); // 直後 (0.05 秒後) に落ちている
    if (log[i].shift === 'down') afterDown.push(log[i + 3].rpm - log[i - 1].rpm); // 直後に跳ねている
  }
  assert.ok(afterUp.length > 3 && afterUp.filter((d) => d > 500).length / afterUp.length > 0.7, 'シフトアップで回転が落ちる');
  assert.ok(afterDown.length > 3 && afterDown.filter((d) => d > 300).length / afterDown.length > 0.7, 'シフトダウンで回転が上がる');
});

test('加速中はスロットルが大きく、減速中 (ブレーキ) はほぼ 0、シフトアップ中は 0', () => {
  const log = drive(2);
  const accel = log.filter((f, i) => i > 0 && f.speed - log[i - 1].speed > 0.5 && !f.shift);
  const brake = log.filter((f, i) => i > 0 && f.speed - log[i - 1].speed < -0.8);
  assert.ok(accel.length > 50 && brake.length > 50);
  const mean = (a) => a.reduce((s, f) => s + f.throttle, 0) / a.length;
  assert.ok(mean(accel) > 0.6, `加速 ${mean(accel)}`);
  assert.ok(mean(brake) < 0.15, `減速 ${mean(brake)}`);
  const cut = log.filter((f, i) => i > 0 && log[i - 1].shift === 'up' && !f.shift);
  assert.ok(cut.length > 3 && cut.every((f) => f.throttle === 0), 'シフトアップ直後はスロットルオフ');
});

test('起動直後の大きな速度の飛びでも、ギアを一気に選ぶ (連続で変速しない)', () => {
  const m = new EngineModel();
  m.update(1 / 60, 0, 600); // 停止中
  m.update(1 / 60, 540, 600); // 一気に 216km/h
  assert.equal(m.gear, 5);
  assert.ok(m.rpm < 7600);
});

test('フレームレート (30 / 60 / 120fps) によらず、変速の回数はほぼ同じ', () => {
  const count = (fps) => drive(2, defaults(), fps).filter((f) => f.shift).length;
  const a = count(30);
  const b = count(60);
  const c = count(120);
  assert.ok(Math.abs(a - b) <= 3 && Math.abs(c - b) <= 3, `${a} ${b} ${c}`);
});

test('同じ入力なら同じ結果 (再現性)', () => {
  const a = drive(1).map((f) => f.rpm);
  const b = drive(1).map((f) => f.rpm);
  assert.deepEqual(a, b);
});

test('スキール量: ドリフトが浅いと 0、深いほど大きい、0〜1 に収まる、最大角 0 では 0', () => {
  const s = (deg, max = 35, sp = 600) => squealLevel(deg * DEG, max, sp, 600);
  assert.equal(s(3), 0);
  assert.ok(s(15) < s(25) && s(25) < s(35));
  assert.ok(s(60) <= 1 && s(35) > 0.8);
  assert.equal(s(30, 0), 0);
  // 同じ角度なら速いほど大きい
  assert.ok(s(25, 35, 600) > s(25, 35, 250));
  // 角度の符号に依らない
  assert.equal(squealLevel(-25 * DEG, 35, 600, 600), s(25));
});

test('点火の基本周波数: 6 気筒 4 サイクルで rpm / 20 Hz', () => {
  assert.ok(Math.abs(firingHz(6000) - 300) < 1e-9);
  assert.ok(Math.abs(firingHz(3000) - 150) < 1e-9);
});
