import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../js/track.js';

const track = new Track();
const garage = new Track('garage');

test('トンネル: ridge コースに 2 つ (① と ⑧)。1 つ目は ① の入り口から ② の手前まで、左辺を北へ向かう区間', () => {
  assert.equal(track.tunnels.length, 2);
  const tu = track.tunnels[0];
  assert.ok(tu.s0 < tu.s1, '入口が先');
  const a = track.at(tu.s0);
  const b = track.at(tu.s1);
  const pa = [a.x / 6.5, a.y / 6.5];
  const pb = [b.x / 6.5, b.y / 6.5];
  // 入口は ① の枠の右端 (x≈105, 下辺)、出口は ② の枠の下 (x≈24, y≈362)
  assert.ok(Math.abs(pa[0] - 105) < 12 && Math.abs(pa[1] - 516) < 12, `入口 ${pa}`);
  assert.ok(Math.abs(pb[0] - 24) < 12 && Math.abs(pb[1] - 362) < 12, `出口 ${pb}`);
  const len = tu.s1 - tu.s0;
  assert.ok(len > 900 && len < 1800, `長さ ${len}`);
  // スタート (周回の始点) をまたがない
  assert.ok(tu.s0 > track.finishS && tu.s1 < track.length);
});

test('トンネル: 地下駐車場には無い', () => {
  assert.equal(garage.tunnels.length, 0);
});

test('トンネル: ⑧ は丸ごとトンネル (斜めの下りの入口 → 左コーナーの出口)。ジャンプの着地は入口の手前か中', () => {
  assert.equal(track.tunnels.length, 2);
  const tu = track.tunnels[1];
  const a = track.at(tu.s0);
  const b = track.at(tu.s1);
  assert.ok(Math.abs(a.x / 6.5 - 300) < 12 && Math.abs(a.y / 6.5 - 275) < 12, `入口 ${a.x / 6.5},${a.y / 6.5}`);
  assert.ok(Math.abs(b.x / 6.5 - 310) < 12 && Math.abs(b.y / 6.5 - 431) < 12, `出口 ${b.x / 6.5},${b.y / 6.5}`);
  const len = tu.s1 - tu.s0;
  assert.ok(len > 1000 && len < 2200, `長さ ${len}`);
  // 1 つ目のトンネルと重ならず、順に並ぶ
  assert.ok(track.tunnels[0].s1 < tu.s0 && tu.s1 < track.length);
  // ジャンプ台はトンネルの外 (入口より手前)
  assert.ok(track.jumps[0].s < tu.s0);
});
