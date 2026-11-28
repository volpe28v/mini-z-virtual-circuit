import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../js/track.js';

const track = new Track();
const garage = new Track('garage');

test('トンネル: ridge コースに 1 つ。① の入り口から ② の手前まで、左辺を北へ向かう区間', () => {
  assert.equal(track.tunnels.length, 1);
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
