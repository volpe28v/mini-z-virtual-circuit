import test from 'node:test';
import assert from 'node:assert/strict';
import { Track, COURSES } from '../js/track.js';
import { Vehicle } from '../js/vehicle.js';
import { defaults, sanitize } from '../js/settings.js';

const DEG = 180 / Math.PI;
const dd = new Track('ddlabo');

test('DDLabo 風: コースの定義 (屋内のマット、床いっぱいのアスファルト)', () => {
  assert.equal(dd.course.id, 'ddlabo');
  assert.equal(dd.course.theme, 'pad');
  assert.equal(dd.course.studio, true);
  assert.equal(COURSES.ddlabo.indoor, false);
  assert.equal(dd.tunnels.length + dd.bridges.length + dd.beaches.length + dd.jumps.length, 0);
});

test('DDLabo 風: マット (実物 2.4m × 1.5m の 80% + 四方 80mm の余白) の内側に、外側の白線まで収まる一方通行の閉ループ (1 周でちょうど 360°、自己交差なし)', () => {
  const b = dd.bounds();
  const [mw, mh] = dd.course.mat;
  const m = dd.course.matMargin;
  assert.deepEqual([mw, mh, m], [2080, 1360, 80]);
  // 写真の範囲 (1.92m × 1.2m) + 四方へ 80mm の余白 = 黄色の枠。ライン本体も、外側の白線 (120mm) も、枠の内側に収まる
  const lineD = dd.padLines[0].d;
  assert.ok(b.minX - lineD >= -m && b.maxX + lineD <= mw - m && b.minY - lineD >= -m && b.maxY + lineD <= mh - m, `外側の白線まで枠の内側: ${JSON.stringify(b)} d=${lineD}`);
  assert.ok(b.minX > 50 && b.maxX < mw - m - 50 && b.minY > 50 && b.maxY < mh - m - 50, 'ライン本体はマットの端から余裕がある');
  assert.ok(Math.abs(dd.course.scale * 1331 - (mw - 2 * m)) < 1 && Math.abs(dd.course.scale * 832 - (mh - 2 * m)) < 1, '写真の範囲の大きさは 1331 × 832 px の縮尺と合っている');
  assert.ok(Math.abs(Math.abs(dd.totalTurn) * DEG - 360) < 1, `${dd.totalTurn * DEG}`);
  // 時計回り (画面で右回り): 曲率の符号が正 (y 下向きの座標)
  assert.ok(dd.totalTurn > 0);
  // 自己交差なし: 離れたサンプル同士の線分が交わらない
  const N = dd.N;
  const step = 8;
  const seg = [];
  for (let i = 0; i < N; i += step) seg.push([dd.x[i], dd.y[i], dd.x[(i + step) % N], dd.y[(i + step) % N]]);
  const cross = (p, q) => {
    const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const a = [p[0], p[1]];
    const b2 = [p[2], p[3]];
    const c = [q[0], q[1]];
    const e = [q[2], q[3]];
    return d(a, b2, c) * d(a, b2, e) < 0 && d(c, e, a) * d(c, e, b2) < 0;
  };
  for (let i = 0; i < seg.length; i++) for (let j = i + 2; j < seg.length; j++) if (!(i === 0 && j === seg.length - 1)) assert.equal(cross(seg[i], seg[j]), false, `交差 ${i},${j}`);
});

test('DDLabo 風: 左の輪 (右回り) → ロゴの周り (左回り 約 270°) → 青いエリア + 右の大きな輪 (右回り 約 360°) の順', () => {
  // 曲率の符号が同じ区間ごとに曲がった角度を集める (緩い直線は区切らず、60° 未満の小さな振れは無視する)
  const runs = [];
  let cur = Math.sign(dd.kappa[0]);
  let ang = 0;
  let len = 0;
  const flush = () => runs.push({ sign: cur, ang: ang * DEG, len });
  for (let i = 0; i < dd.N; i++) {
    const k = dd.kappa[i];
    if (Math.abs(k) < 1 / 3000) continue;
    if (Math.sign(k) !== cur) {
      flush();
      cur = Math.sign(k);
      ang = 0;
      len = 0;
    }
    ang += k * dd.ds;
    len += dd.ds;
  }
  flush();
  const big = runs.filter((r) => Math.abs(r.ang) > 60);
  assert.deepEqual(big.map((r) => r.sign), [1, -1, 1], JSON.stringify(runs)); // 右・左・右
  // 8 → 9 (左の輪からロゴの周りへの S 字) は、曲がる向きが 1 回だけ変わる滑らかな S 字 (余計な振れ・小さな反対向きの曲がりが無い)
  assert.equal(runs.length, 3, `曲がる向きの変わり目は 2 つだけ: ${JSON.stringify(runs)}`);
  assert.ok(big[0].ang > 200 && big[0].ang < 290, `左の輪 ${big[0].ang}`);
  assert.ok(big[1].ang < -220 && big[1].ang > -290, `ロゴの周り ${big[1].ang}`);
  assert.ok(big[2].ang > 310 && big[2].ang < 390, `青いエリア + 右の輪 ${big[2].ang}`);
  // 半径は最小でも 140mm 以上 (ロゴの周りと青いエリアの周り)
  let minR = Infinity;
  for (let i = 0; i < dd.N; i++) minR = Math.min(minR, 1 / Math.max(1e-9, Math.abs(dd.kappa[i])));
  assert.ok(minR > 140, `minR=${minR}`);
  // 離れた区間どうし (ロゴの周りと下辺のストレート、左の輪など) は 150mm 以上離れている
  let minD = Infinity;
  for (let i = 0; i < dd.N; i += 4) {
    for (let j = i + 1; j < dd.N; j += 4) {
      const arc = Math.min(j - i, dd.N - (j - i)) * dd.ds;
      if (arc < 900) continue;
      minD = Math.min(minD, Math.hypot(dd.x[i] - dd.x[j], dd.y[i] - dd.y[j]));
    }
  }
  assert.ok(minD > 150, `通路の間隔 ${minD}`);
});

test('DDLabo 風: 3 周走れて、車体はコーナーの内側を向く (ロゴの周りでは左、他では右)', () => {
  const st = defaults();
  const v = new Vehicle(dd);
  v.reset(0);
  let agree = 0;
  let total = 0;
  while (v.progress < 3 * dd.length) {
    v.update(1 / 60, st);
    assert.ok(Number.isFinite(v.position.x) && Number.isFinite(v.heading));
    const k = dd.kappaAt(v.progress);
    if (Math.abs(k) > 1 / 700 && Math.abs(v.driftAngle) * DEG > 8) {
      total++;
      if (Math.sign(v.driftAngle) === Math.sign(k)) agree++;
    }
  }
  assert.ok(total > 100, `ドリフトしている ${total}`);
  assert.ok(agree / total > 0.85, `向きの一致 ${agree}/${total}`);
});

test('設定: コースに ddlabo を選べる', () => {
  assert.equal(sanitize({ course: 'ddlabo' }).course, 'ddlabo');
});

test('DDLabo 風: 白線は外側 (進行方向の左) の 1 本が基本で、中央ライン (内側の円弧) が 3 か所に部分的に入る', () => {
  const ls = dd.padLines;
  assert.equal(ls.length, 4);
  const outer = ls.filter((l) => l.side === -1);
  const center = ls.filter((l) => l.side === 1);
  // 外側は周回の継ぎ目をまたぐ長い区間 (全周の半分以上)
  const len = (l) => (((l.i1 - l.i0) % dd.N) + dd.N) % dd.N;
  assert.ok(len(outer[0]) > 0.5 * dd.N, `外側 ${len(outer[0])}/${dd.N}`);
  assert.ok(outer[0].i0 > outer[0].i1, '周回の継ぎ目をまたぐ');
  // 中央ラインは短く、大きな輪の内側 (右回りの区間) か、ロゴの周りの右側
  for (const l of center) assert.ok(len(l) < 0.12 * dd.N && len(l) > 0.02 * dd.N, `中央 ${len(l)}`);
  // 白線の側は、輪の内側・外側に合っている: 左の輪の内側 (+1) は輪の中心側
  const c = ls[1];
  const mid = Math.round((c.i0 + c.i1) / 2);
  const th = dd.theta[mid];
  const px = dd.x[mid] - Math.sin(th) * 85; // +法線 (進行方向の右) の 85mm 先
  const py = dd.y[mid] + Math.cos(th) * 85;
  const cx = 375 * dd.course.scale; // 左の輪の中心 (図の px × scale)
  assert.ok(Math.hypot(px - cx, py - 445 * dd.course.scale) < Math.hypot(dd.x[mid] - cx, dd.y[mid] - 445 * dd.course.scale), '内側の線は輪の中心に近い');
});

test('DDLabo 風: 大きな輪 (左・右) でも、ドリフトしっぱなし (角度 38° 以上を保ち、道の中央を滑る)', () => {
  const st = defaults();
  const v = new Vehicle(dd);
  v.reset(0);
  let inLoop = 0;
  let deep = 0;
  let maxOut = 0;
  let peak = 0;
  while (v.progress < 3 * dd.length) {
    v.update(1 / 60, st);
    if (v.progress < dd.length) continue; // 1 周目は立ち上がり
    const k = dd.kappaAt(v.progress);
    // 左右の大きな輪 (半径 360〜560mm の右回り)
    if (k > 1 / 560 && k < 1 / 360) {
      inLoop++;
      if (v.driftAngle * DEG > 38) deep++;
      maxOut = Math.max(maxOut, Math.abs(v.offset));
      peak = Math.max(peak, v.driftAngle * DEG);
    }
  }
  assert.ok(inLoop > 500, `輪の中のステップ数 ${inLoop}`);
  assert.ok(deep / inLoop > 0.8, `38° 以上を保った割合 ${(deep / inLoop).toFixed(2)}`);
  assert.ok(peak < 55, `最大 ${peak.toFixed(0)}°`);
  assert.ok(maxOut < 30, `中心のずれ ${maxOut.toFixed(0)}mm (道の中央を滑る)`);
});

test('DDLabo 風: 大きな輪で、車体の四隅が外側の白線 (外へ 120mm) に被らない', () => {
  const st = defaults();
  const v = new Vehicle(dd);
  v.reset(0);
  const Lc = st.carLength;
  const Wc = st.carWidth;
  let outMax = 0;
  let n = 0;
  while (v.progress < 3 * dd.length) {
    v.update(1 / 60, st);
    if (v.progress < dd.length) continue;
    const k = dd.kappaAt(v.progress);
    if (!(k > 1 / 560 && k < 1 / 360)) continue;
    const hint = Math.round((v.progress % dd.length) / dd.ds);
    const c = Math.cos(v.heading);
    const s = Math.sin(v.heading);
    for (const [a, b] of [[Lc / 2, Wc / 2], [Lc / 2, -Wc / 2], [-Lc / 2, Wc / 2], [-Lc / 2, -Wc / 2]]) {
      const x = v.position.x + a * c - b * s;
      const y = v.position.y + a * s + b * c;
      let bi = hint;
      let bd = Infinity;
      for (let d = -60; d <= 60; d++) {
        const i = (((hint + d) % dd.N) + dd.N) % dd.N;
        const dist = Math.hypot(x - dd.x[i], y - dd.y[i]);
        if (dist < bd) {
          bd = dist;
          bi = i;
        }
      }
      const th = dd.theta[bi];
      const side = (x - dd.x[bi]) * -Math.sin(th) + (y - dd.y[bi]) * Math.cos(th); // 進行方向の右が正
      outMax = Math.max(outMax, -side); // 左 (外側) への張り出し
    }
    n++;
  }
  assert.ok(n > 500);
  const lineD = dd.padLines[0].d;
  assert.equal(lineD, 120);
  assert.ok(outMax < lineD - 20, `車体の四隅の外側への張り出し ${outMax.toFixed(0)}mm (外側の白線は ${lineD}mm)`);
});
