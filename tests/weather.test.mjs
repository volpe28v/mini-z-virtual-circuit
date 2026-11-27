import test from 'node:test';
import assert from 'node:assert/strict';
import { Weather } from '../js/weather.js';
import { defaults, sanitize } from '../js/settings.js';

function run(seed, seconds, fps = 30) {
  const w = new Weather(seed);
  const log = [];
  const dt = 1 / fps;
  for (let i = 0; i < seconds * fps; i++) {
    w.update(dt);
    log.push({ rain: w.rain, wet: w.wet, phase: w.phase });
  }
  return log;
}

test('晴れ・小雨・土砂降りを順に巡る (10 分のあいだに全部現れ、土砂降りは小雨の後に来る)', () => {
  const log = run(1, 600);
  const seen = new Set(log.map((l) => l.phase));
  for (const p of ['clear', 'drizzle', 'heavy']) assert.ok(seen.has(p), `${p} が現れない`);
  // 土砂降りの直前の段階は、必ず小雨
  let prev = log[0].phase;
  for (const l of log) {
    if (l.phase !== prev) {
      if (l.phase === 'heavy') assert.equal(prev, 'drizzle');
      prev = l.phase;
    }
  }
});

test('雨の強さ・濡れ具合は 0〜1 で、なめらかに変わる (急に飛ばない)', () => {
  const log = run(2, 600);
  let maxStepRain = 0;
  let maxStepWet = 0;
  for (let i = 1; i < log.length; i++) {
    assert.ok(log[i].rain >= 0 && log[i].rain <= 1 && log[i].wet >= 0 && log[i].wet <= 1);
    maxStepRain = Math.max(maxStepRain, Math.abs(log[i].rain - log[i - 1].rain));
    maxStepWet = Math.max(maxStepWet, Math.abs(log[i].wet - log[i - 1].wet));
  }
  assert.ok(maxStepRain < 0.02, `rain 1 フレームの変化 ${maxStepRain}`);
  assert.ok(maxStepWet < 0.02, `wet 1 フレームの変化 ${maxStepWet}`);
});

test('路面は、雨がやんでもしばらく濡れていて、ゆっくり乾く (降り始めより乾くほうが遅い)', () => {
  const w = new Weather(3);
  w.rain = 1;
  w.from = 1;
  w.to = 1;
  w.fadeLen = 1e9; // 段階の切り替えを止めて、濡れ具合だけを見る
  w.fade = 0;
  let tWet = 0;
  while (w.wet < 0.63) {
    w.update(0.1);
    tWet += 0.1;
  }
  w.rain = 0;
  w.from = 0;
  w.to = 0;
  let tDry = 0;
  while (w.wet > 0.23) {
    w.update(0.1);
    tDry += 0.1;
  }
  assert.ok(tDry > tWet * 2, `濡れるまで ${tWet.toFixed(1)}s、乾くまで ${tDry.toFixed(1)}s`);
});

test('同じ種なら同じ天気 (再現性)、種が違えば違う', () => {
  assert.deepEqual(run(5, 200), run(5, 200));
  assert.notDeepEqual(run(5, 400).map((l) => l.phase), run(6, 400).map((l) => l.phase));
});

test('フレームレートによらず、ほぼ同じ天気になる', () => {
  const a = run(7, 300, 30);
  const b = run(7, 300, 120);
  const at = (log, fps, s) => log[Math.floor(s * fps) - 1].wet;
  for (const s of [60, 120, 200, 300]) assert.ok(Math.abs(at(a, 30, s) - at(b, 120, s)) < 0.05, `t=${s}`);
});

test('設定: 天候の自動変化は既定で ON、保存値の補正も効く', () => {
  assert.equal(defaults().autoWeather, true);
  assert.equal(sanitize({ autoWeather: false }).autoWeather, false);
  assert.equal(sanitize({ wet: 5 }).wet, 1);
});
