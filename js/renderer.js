// ワールド描画。パス (路面・縁石・ランオフ・白線・タイヤ痕) は設定変更時にだけ組み立て、毎フレームは塗るだけ。
import { cameraMatrix, viewRadiusMm, carGeometry } from './camera.js';
import { simulateRubber } from './marks.js';
import { TILE_MM } from './textures.js';
import { smokeSize, smokeAlpha } from './smoke.js';

const KERB_W = 18; // 縁石の幅 (mm)
const KERB_QUAD = 7; // 縁石 1 区画 = 7 サンプル (約 28mm)
const CORNER_K = 1 / 650; // この曲率より急な区間をコーナーとみなす
const RUNOFF_W = 55; // ランオフの最大幅 (mm)
const PATH_STRIDE = 2; // 路面パスのサンプル間隔 (8mm)

export class Renderer {
  constructor(canvas, track, textures) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.scene = document.createElement('canvas');
    this.sctx = this.scene.getContext('2d', { alpha: false });
    this.track = track;
    this.tex = textures;
    this.pr = 1;
    this.cssW = 1;
    this.cssH = 1;
    this.patCache = new Map();
    this.world = null;
    this.marks = null;

    const N = track.N;
    this.nx = new Float64Array(N);
    this.ny = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.nx[i] = -Math.sin(track.theta[i]);
      this.ny[i] = Math.cos(track.theta[i]);
    }
    this.corners = this._findCorners();
    this._tmp = {};
    this.smoke = null; // SmokeSystem (main.js が設定)
    this.skids = null; // SkidMarks (main.js が設定)
    this._skidPath = null;
    this._skidVersion = -1;
    this.smokeSprite = this._makeSmokeSprite();
    this.spraySprite = this._makeSmokeSprite([214, 228, 244]); // 雨の水煙 (青みがかった白)
    this._t0 = 0;
  }

  // 煙 1 粒ぶんの、ふわっとした円形のスプライト (1 枚を拡大縮小して使い回す)
  _makeSmokeSprite(rgb = [240, 240, 240]) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    const [R, G, B] = rgb;
    grad.addColorStop(0, `rgba(${R + 6},${G + 6},${B + 6},1)`);
    grad.addColorStop(0.35, `rgba(${R},${G},${B},0.6)`);
    grad.addColorStop(1, `rgba(${R - 8},${G - 8},${B - 8},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  resize(cssW, cssH, dpr, renderScale = 1) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.pr = Math.min(dpr || 1, 2) * renderScale;
    const w = Math.max(1, Math.round(cssW * this.pr));
    const h = Math.max(1, Math.round(cssH * this.pr));
    for (const c of [this.canvas, this.scene]) {
      c.width = w;
      c.height = h;
    }
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.ctx.fillStyle = '#20301c';
    this.ctx.fillRect(0, 0, w, h);
  }

  // ---- パターン (ワールド座標に固定) ----
  _patterns(ctx) {
    let p = this.patCache.get(ctx);
    if (p) return p;
    const mk = (img, mm, rot = 0) => {
      const pat = ctx.createPattern(img, 'repeat');
      if (pat.setTransform && typeof DOMMatrix !== 'undefined') {
        pat.setTransform(new DOMMatrix().rotate(rot).scale(mm / img.width));
      }
      return pat;
    };
    p = {
      asphalt: mk(this.tex.asphalt, TILE_MM.asphalt),
      grass: mk(this.tex.grass, TILE_MM.grass),
      gravel: mk(this.tex.gravel, TILE_MM.gravel),
    };
    this.patCache.set(ctx, p);
    return p;
  }

  _off(path, i, d, first) {
    const t = this.track;
    const j = ((i % t.N) + t.N) % t.N;
    const x = t.x[j] + this.nx[j] * d;
    const y = t.y[j] + this.ny[j] * d;
    if (first) path.moveTo(x, y);
    else path.lineTo(x, y);
  }

  // |κ| が大きい連続区間をコーナーとして抽出 (サンプル添字は i0 からの相対)
  _findCorners() {
    const { N, kappa } = this.track;
    let i0 = 0;
    for (let i = 0; i < N; i++) {
      if (Math.abs(kappa[i]) < CORNER_K * 0.4) {
        i0 = i;
        break;
      }
    }
    const runs = [];
    let cur = null;
    for (let c = 0; c < N; c++) {
      const k = kappa[(i0 + c) % N];
      if (Math.abs(k) > CORNER_K) {
        if (!cur) cur = { a: c, b: c, peak: 0, sign: 0 };
        cur.b = c;
        if (Math.abs(k) > cur.peak) {
          cur.peak = Math.abs(k);
          cur.sign = Math.sign(k);
        }
      } else if (cur) {
        runs.push(cur);
        cur = null;
      }
    }
    if (cur) runs.push(cur);
    // 同じ向きで近い区間は 1 つにまとめる
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.sign === r.sign && r.a - last.b < 20) {
        last.b = r.b;
        last.peak = Math.max(last.peak, r.peak);
      } else merged.push({ ...r });
    }
    // 短い曲がり (約 200mm 未満) には縁石・ランオフを付けない
    const minLen = Math.round(200 / this.track.ds);
    return merged.filter((r) => r.b - r.a > minLen).map((r) => ({ ...r, i0 }));
  }

  // ---- ワールドのパス組み立て ----
  buildWorld(st) {
    const t = this.track;
    const W = st.trackWidth;
    const half = W / 2;
    const road = new Path2D();
    const leftEdge = new Path2D();
    const rightEdge = new Path2D();
    for (let i = 0, first = true; i < t.N; i += PATH_STRIDE, first = false) {
      this._off(road, i, half, first);
      this._off(leftEdge, i, half, first);
    }
    road.closePath();
    leftEdge.closePath();
    for (let i = 0, first = true; i < t.N; i += PATH_STRIDE, first = false) {
      this._off(road, i, -half, first);
      this._off(rightEdge, i, -half, first);
    }
    road.closePath();
    rightEdge.closePath();

    const red = new Path2D();
    const white = new Path2D();
    const kerbOuter = new Path2D();
    const kerbInner = new Path2D();
    const runoff = new Path2D();

    const kerb = (corner, side, c0, c1) => {
      const a = Math.round(c0);
      const b = Math.round(c1);
      if (b - a < KERB_QUAD * 3) return;
      const d0 = side * (half - 1.5);
      const d1 = side * (half + KERB_W);
      const idx = (c) => corner.i0 + c;
      let q = 0;
      let c = a;
      for (; c + KERB_QUAD <= b; c += KERB_QUAD, q++) {
        const p = q & 1 ? white : red;
        for (let j = 0; j <= KERB_QUAD; j++) this._off(p, idx(c + j), d0, j === 0);
        for (let j = KERB_QUAD; j >= 0; j--) this._off(p, idx(c + j), d1, false);
        p.closePath();
      }
      for (let j = a; j <= c; j++) this._off(kerbOuter, idx(j), d1 + side * 0.8, j === a);
      for (let j = a; j <= c; j++) this._off(kerbInner, idx(j), d0 + side * 2, j === a);
    };

    const runoffStrip = (corner, side, c0, c1) => {
      const a = Math.round(c0);
      const b = Math.round(c1);
      if (b - a < 12) return;
      const dBase = side * (half + KERB_W - 1);
      const idx = (c) => corner.i0 + c;
      for (let c = a; c <= b; c++) this._off(runoff, idx(c), dBase, c === a);
      for (let c = b; c >= a; c--) {
        const u = (c - a) / (b - a);
        const w = RUNOFF_W * Math.pow(Math.sin(Math.PI * u), 0.7);
        this._off(runoff, idx(c), dBase + side * w, false);
      }
      runoff.closePath();
    };

    for (const co of this.corners) {
      const L = co.b - co.a;
      const inside = co.sign; // κ > 0 の内側は法線側
      const outside = -co.sign;
      kerb(co, inside, co.a + 0.15 * L, co.b - 0.15 * L);
      kerb(co, outside, co.a + 0.3 * L, Math.min(co.b + 0.1 * L, co.b + 12));
      runoffStrip(co, outside, co.a + 0.3 * L, co.b + 0.2 * L);
    }

    const puddles = this._buildPuddles(half);
    this.world = { W, road, leftEdge, rightEdge, red, white, kerbOuter, kerbInner, runoff, puddles };
    this.buildMarks(st);
  }

  // 水たまり: 路面に固定した楕円 (走行方向に細長い)。固定の種で作るので毎回同じ場所
  _buildPuddles(half) {
    const t = this.track;
    const body = new Path2D();
    const shine = new Path2D();
    let a = 20260101;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const count = Math.round(t.length / 95);
    for (let n = 0; n < count; n++) {
      const i = Math.floor(rnd() * t.N);
      const d = (rnd() - 0.5) * 2 * half * 0.8;
      const x = t.x[i] + this.nx[i] * d;
      const y = t.y[i] + this.ny[i] * d;
      const rx = 10 + rnd() * 26; // 走行方向
      const ry = 4 + rnd() * 9;
      body.moveTo(x + rx * Math.cos(t.theta[i]), y + rx * Math.sin(t.theta[i]));
      body.ellipse(x, y, rx, ry, t.theta[i], 0, Math.PI * 2);
      shine.moveTo(x - rx * 0.2 + rx * 0.5, y);
      shine.ellipse(x - rx * 0.15 * Math.cos(t.theta[i]), y - rx * 0.15 * Math.sin(t.theta[i]) - ry * 0.25, rx * 0.5, ry * 0.3, t.theta[i], 0, Math.PI * 2);
    }
    return { body, shine };
  }

  // ラバーライン (走行ラインの黒ずみ)。設定が変わったときに作り直す
  buildMarks(st) {
    const rubber = simulateRubber(this.track, st);
    const rub = new Path2D();
    if (rubber.length >= 4) {
      rub.moveTo(rubber[0], rubber[1]);
      for (let i = 2; i < rubber.length; i += 2) rub.lineTo(rubber[i], rubber[i + 1]);
      rub.closePath();
    }
    this.marks = { rubber: rub };
  }

  // 実際の走行から記録したタイヤ痕を、濃さの段階ごとの Path2D にする (痕が増減したときだけ)
  _skidPaths() {
    const sk = this.skids;
    if (this._skidVersion === sk.version && this._skidPath) return this._skidPath;
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (const c of sk.chunks) {
      const p = paths[c.b];
      p.moveTo(c.pts[0], c.pts[1]);
      for (let i = 2; i < c.pts.length; i += 2) p.lineTo(c.pts[i], c.pts[i + 1]);
    }
    this._skidPath = paths;
    this._skidVersion = sk.version;
    return paths;
  }

  // ---- フレーム描画 ----
  render(cam, st, vehicle, overview = false) {
    if (!this.world) this.buildWorld(st);
    this._overview = overview;
    const blurOn = st.motionBlur > 0.01 && !overview;
    const ctx = blurOn ? this.sctx : this.ctx;
    this._drawWorld(ctx, cam, st);
    if (blurOn) {
      const ratio = Math.min(1, Math.max(0.35, vehicle.speed / Math.max(1, st.speed * 0.8)));
      const m = this.ctx;
      m.setTransform(1, 0, 0, 1, 0, 0);
      m.globalAlpha = 1 - st.motionBlur * ratio;
      m.drawImage(this.scene, 0, 0);
      m.globalAlpha = 1;
    }
    if (st.showCar && !overview) this._drawDebugCar(this.ctx, cam, st, vehicle);
  }

  _drawWorld(ctx, cam, st) {
    const w = this.world;
    const P = this._patterns(ctx);
    const m = cameraMatrix(cam, this.pr);
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    const r = viewRadiusMm(cam, this.cssW, this.cssH) * 1.04 + 20;
    const gx = cam.px - r;
    const gy = cam.py - r;

    // 芝 (大きな色むらはタイルに焼き込み済み)
    ctx.fillStyle = P.grass;
    ctx.fillRect(gx, gy, 2 * r, 2 * r);

    // ランオフ (砂利)
    ctx.fillStyle = P.gravel;
    ctx.fill(w.runoff);
    ctx.strokeStyle = 'rgba(30,24,16,0.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke(w.runoff);

    const wet = Math.min(1, Math.max(0, st.wet || 0));
    // 縁石 (赤白) + 汚れ + 立体感の線
    ctx.fillStyle = '#c4272c';
    ctx.fill(w.red);
    ctx.fillStyle = '#e9e6de';
    ctx.fill(w.white);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.38)';
    ctx.lineWidth = 2.6;
    ctx.stroke(w.kerbOuter);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.1;
    ctx.stroke(w.kerbInner);

    // 雨: 芝・砂利・縁石をまとめて少し暗く
    if (wet > 0.01) {
      ctx.fillStyle = `rgba(4,12,22,${(0.2 * wet).toFixed(3)})`;
      ctx.fillRect(gx, gy, 2 * r, 2 * r);
    }

    // 路面
    ctx.fillStyle = P.asphalt;
    ctx.fill(w.road, 'evenodd');
    if (wet > 0.01) {
      // 濡れたアスファルトは暗く青みがかり、水たまりが光る
      ctx.fillStyle = `rgba(8,16,30,${(0.45 * wet).toFixed(3)})`;
      ctx.fill(w.road, 'evenodd');
      const pu = Math.min(1, Math.max(0, (wet - 0.2) / 0.5));
      if (pu > 0) {
        ctx.globalAlpha = pu;
        ctx.fillStyle = 'rgba(70,92,120,0.38)';
        ctx.fill(w.puddles.body);
        ctx.fillStyle = 'rgba(210,225,245,0.26)';
        ctx.fill(w.puddles.shine);
        ctx.globalAlpha = 1;
      }
    }

    // ラバーライン (走行ラインの黒ずみ) とタイヤ痕
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.055)';
    ctx.lineWidth = Math.min(60, w.W * 0.6);
    ctx.stroke(this.marks.rubber);
    ctx.lineWidth = Math.min(26, w.W * 0.28);
    ctx.stroke(this.marks.rubber);
    if (wet > 0.01) {
      // 濡れた走行ラインは、ゴムが水を弾いてうっすら光る
      ctx.strokeStyle = `rgba(170,190,215,${(0.06 * wet).toFixed(3)})`;
      ctx.lineWidth = Math.min(18, w.W * 0.18);
      ctx.stroke(this.marks.rubber);
    }
    if (this.skids && !this._overview) {
      const f = 1 - 0.6 * wet; // 濡れた路面では痕が薄い
      const alphas = [0.09 * f, 0.15 * f, 0.24 * f];
      const done = this._skidPaths();
      ctx.lineWidth = 4.5;
      for (let b = 0; b < 3; b++) {
        ctx.strokeStyle = `rgba(8,8,8,${alphas[b]})`;
        ctx.stroke(done[b]);
        // 記録中 (まだ区切っていない) の痕
        for (const cur of this.skids.open) {
          if (!cur || cur.b !== b || cur.pts.length < 4) continue;
          ctx.beginPath();
          ctx.moveTo(cur.pts[0], cur.pts[1]);
          for (let i = 2; i < cur.pts.length; i += 2) ctx.lineTo(cur.pts[i], cur.pts[i + 1]);
          ctx.stroke();
        }
      }
    }

    // 路面端の白線
    ctx.strokeStyle = 'rgba(232,232,226,0.88)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'butt';
    ctx.stroke(w.leftEdge);
    ctx.stroke(w.rightEdge);

    this._drawFinishLine(ctx, w.W);
    if (!this._overview && this.smoke && st.smoke > 0) this._drawSmoke(ctx, cam, r, wet);
    const rain = Math.min(1, Math.max(0, st.rain ?? st.wet ?? 0));
    if (rain > 0.2 && !this._overview) this._drawRain(ctx, cam, r, rain);
  }

  // 雨粒が路面に当たってできる波紋。路面 (ワールド座標) に固定されていて、路面と一緒に流れる。
  // ワールドを格子に区切り、格子ごとに「いつ・どこに落ちるか」を位置と時刻から決める (状態を持たない)
  _drawRain(ctx, cam, viewR, wet) {
    const C = 34; // 格子の大きさ (mm)
    const t = performance.now() / 1000;
    const hash = (x, y, z) => {
      const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
      return h - Math.floor(h);
    };
    const groups = [new Path2D(), new Path2D(), new Path2D()];
    const x0 = Math.floor((cam.px - viewR) / C);
    const x1 = Math.floor((cam.px + viewR) / C);
    const y0 = Math.floor((cam.py - viewR) / C);
    const y1 = Math.floor((cam.py + viewR) / C);
    const density = Math.min(1, 0.9 * wet); // wet は降り方 (rain)
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        if (hash(gx, gy, 1) > density) continue; // 雨が弱いと、落ちる格子が少ない
        const period = 0.8 + hash(gx, gy, 2) * 0.9;
        const ph = t / period + hash(gx, gy, 3);
        const cyc = Math.floor(ph);
        const f = ph - cyc;
        if (f > 0.7) continue; // 波紋が消えたあとは、次の雨粒まで空く
        const u = f / 0.7;
        const x = (gx + hash(gx, gy, 10 + cyc)) * C;
        const y = (gy + hash(gx, gy, 20 + cyc)) * C;
        const rad = 0.8 + 4.6 * u; // 実物の雨粒の波紋ぐらい (数 mm)
        const g = groups[Math.min(2, Math.floor(u * 3))];
        g.moveTo(x + rad, y);
        g.arc(x, y, rad, 0, Math.PI * 2);
      }
    }
    ctx.lineWidth = 1.3 / cam.k;
    const al = [0.32, 0.2, 0.09];
    for (let g = 0; g < 3; g++) {
      ctx.strokeStyle = `rgba(215,228,245,${al[g]})`;
      ctx.stroke(groups[g]);
    }
  }

  _drawSmoke(ctx, cam, viewR, wet = 0) {
    const S = this.smoke;
    const sprite = wet > 0.3 ? this.spraySprite : this.smokeSprite;
    for (let i = 0; i < S.cap; i++) {
      if (!S.alive(i)) continue;
      const a = smokeAlpha(S, i);
      if (a < 0.01) continue;
      const rad = smokeSize(S, i);
      // 視野の外は描かない
      if (Math.abs(S.x[i] - cam.px) > viewR + rad || Math.abs(S.y[i] - cam.py) > viewR + rad) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(sprite, S.x[i] - rad, S.y[i] - rad, rad * 2, rad * 2);
    }
    ctx.globalAlpha = 1;
  }

  _drawFinishLine(ctx, W) {
    const c = this.track.at(this.track.finishS, this._tmp);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.theta);
    const cols = Math.max(4, Math.round(W / 10));
    const cw = W / cols;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < cols; col++) {
        ctx.fillStyle = (row + col) & 1 ? 'rgba(236,236,230,0.92)' : 'rgba(18,18,20,0.9)';
        ctx.fillRect(-15 + row * 10, -W / 2 + col * cw, 10, cw + 0.3);
      }
    }
    ctx.restore();
  }

  _drawDebugCar(ctx, cam, st, v) {
    const k = cam.k;
    ctx.setTransform(this.pr, 0, 0, this.pr, 0, 0);
    ctx.save();
    ctx.translate(cam.ax, cam.ay);
    const L = st.carLength * k;
    const Wd = st.carWidth * k;
    ctx.fillStyle = 'rgba(255,70,70,0.22)';
    ctx.strokeStyle = 'rgba(255,90,90,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(-Wd / 2, -L / 2, Wd, L);
    ctx.fill();
    ctx.stroke();
    // 車輪は車両の長さ・幅の設定に追従する
    const g = carGeometry(st.carLength, st.carWidth);
    const wx = (g.track / 2) * k;
    const wy = (g.wheelbase / 2) * k;
    const tw = g.wheelW * k;
    const th = g.wheelH * k;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) ctx.strokeRect(sx * wx - tw / 2, sy * wy - th / 2, tw, th);
    }
    // 車体の前方 (上)
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -L / 2 - 14);
    ctx.stroke();
    // 進行方向 (車体基準では上から -driftAngle だけ回る)
    const ang = -Math.PI / 2 - v.driftAngle;
    ctx.strokeStyle = 'rgba(80,220,255,0.95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(ang) * 90 * k, Math.sin(ang) * 90 * k);
    ctx.stroke();
    ctx.restore();
  }
}
