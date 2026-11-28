import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../js/track.js';

const track = new Track();
const garage = new Track('garage');

// 点がコースの閉じた輪郭 (中心線) の内側か (偶奇規則)
function inside(px, py) {
  let c = false;
  const N = track.N;
  for (let i = 0, j = N - 1; i < N; j = i++) {
    const yi = track.y[i];
    const yj = track.y[j];
    if (yi > py !== yj > py && px < ((track.x[j] - track.x[i]) * (py - yi)) / (yj - yi) + track.x[i]) c = !c;
  }
  return c;
}

test('砂浜: ridge に 1 つ。④ の出口から ⑥ の入り口まで、約 1.1m', () => {
  assert.equal(track.beaches.length, 1);
  const bc = track.beaches[0];
  const a = track.at(bc.s0);
  const b = track.at(bc.s1);
  assert.ok(Math.abs(a.x / 6.5 - 246) < 12 && Math.abs(a.y / 6.5 - 32) < 12, `入口 ${a.x / 6.5},${a.y / 6.5}`);
  assert.ok(Math.abs(b.x / 6.5 - 400) < 12 && Math.abs(b.y / 6.5 - 106) < 12, `出口 ${b.x / 6.5},${b.y / 6.5}`);
  const len = bc.s1 - bc.s0;
  assert.ok(len > 900 && len < 1500, `長さ ${len}`);
  assert.ok(bc.s0 > track.finishS && bc.s1 < track.length);
});

test('砂浜: 側は進行方向の左で、海はコースの外側にある (周回の内側に海が入らない)', () => {
  const bc = track.beaches[0];
  assert.equal(bc.side, -1);
  for (const f of [0.2, 0.5, 0.8]) {
    const i = Math.round(bc.i0 + (bc.i1 - bc.i0) * f);
    const th = track.theta[i];
    // +法線は進行方向の右 (-sinθ, cosθ)。左 (-法線) の 150mm 先は周回の外
    const lx = track.x[i] + Math.sin(th) * 150;
    const ly = track.y[i] - Math.cos(th) * 150;
    assert.equal(inside(lx, ly), false, `左 150mm は外側 (f=${f})`);
    const rx = track.x[i] - Math.sin(th) * 150;
    const ry = track.y[i] + Math.cos(th) * 150;
    assert.equal(inside(rx, ry), true, `右 150mm は内側 (f=${f})`);
  }
});

test('砂浜: トンネル・橋・ジャンプと重ならない。駐車場には無い', () => {
  const bc = track.beaches[0];
  for (const tu of track.tunnels) assert.ok(tu.s1 < bc.s0 || tu.s0 > bc.s1);
  for (const br of track.bridges) assert.ok(br.s1 < bc.s0 || br.s0 > bc.s1);
  for (const j of track.jumps) assert.ok(j.s < bc.s0 || j.s > bc.s1);
  assert.equal(garage.beaches.length, 0);
});
