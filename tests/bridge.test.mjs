import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../js/track.js';

const track = new Track();
const garage = new Track('garage');

test('吊り橋: ridge に 1 つ。② の出口から ③ の入り口まで (トンネルの次で、ほぼ直線)', () => {
  assert.equal(track.bridges.length, 1);
  const br = track.bridges[0];
  const tu = track.tunnels[0];
  assert.ok(br.s0 > tu.s1 + 500, 'トンネルより後 (② のコーナーを挟む)');
  const a = track.at(br.s0);
  const b = track.at(br.s1);
  const pa = [a.x / 6.5, a.y / 6.5];
  const pb = [b.x / 6.5, b.y / 6.5];
  // ② の枠の右端あたり (x≈155, y≈325) → ③ の枠の下 (x≈192, y≈284)
  assert.ok(Math.abs(pa[0] - 155) < 12 && Math.abs(pa[1] - 325) < 12, `入口 ${pa}`);
  assert.ok(Math.abs(pb[0] - 192) < 12 && Math.abs(pb[1] - 284) < 12, `出口 ${pb}`);
  const len = br.s1 - br.s0;
  assert.ok(len > 300 && len < 700, `長さ ${len}`);
  // 橋の上は急なカーブが無い (半径 500mm 以上)
  for (let s = br.s0; s <= br.s1; s += 20) assert.ok(Math.abs(track.kappaAt(s)) < 1 / 500, `s=${s}`);
});

test('吊り橋: 地下駐車場には無い', () => {
  assert.equal(garage.bridges.length, 0);
});
