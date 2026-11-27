// ワールド描画。パス (路面・縁石・ランオフ・白線・タイヤ痕) は設定変更時にだけ組み立て、毎フレームは塗るだけ。
import { cameraMatrix, viewRadiusMm, carGeometry } from './camera.js';
import { simulateMarks } from './marks.js';
import { TILE_MM } from './textures.js';

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

    this.world = { W, road, leftEdge, rightEdge, red, white, kerbOuter, kerbInner, runoff };
    this.buildMarks(st);
  }

  buildMarks(st) {
    const { buckets, rubber } = simulateMarks(this.track, st);
    const lines = buckets.map((pls) => {
      const p = new Path2D();
      for (const pl of pls) {
        p.moveTo(pl[0], pl[1]);
        for (let i = 2; i < pl.length; i += 2) p.lineTo(pl[i], pl[i + 1]);
      }
      return p;
    });
    const rub = new Path2D();
    if (rubber.length >= 4) {
      rub.moveTo(rubber[0], rubber[1]);
      for (let i = 2; i < rubber.length; i += 2) rub.lineTo(rubber[i], rubber[i + 1]);
      rub.closePath();
    }
    this.marks = { lines, rubber: rub };
  }

  // ---- フレーム描画 ----
  render(cam, st, vehicle, overview = false) {
    if (!this.world) this.buildWorld(st);
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

    // 路面
    ctx.fillStyle = P.asphalt;
    ctx.fill(w.road, 'evenodd');

    // ラバーライン (走行ラインの黒ずみ) とタイヤ痕
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.055)';
    ctx.lineWidth = Math.min(60, w.W * 0.6);
    ctx.stroke(this.marks.rubber);
    ctx.lineWidth = Math.min(26, w.W * 0.28);
    ctx.stroke(this.marks.rubber);
    const alphas = [0.07, 0.12, 0.2];
    ctx.lineWidth = 4.5;
    for (let b = 0; b < 3; b++) {
      ctx.strokeStyle = `rgba(8,8,8,${alphas[b]})`;
      ctx.stroke(this.marks.lines[b]);
    }

    // 路面端の白線
    ctx.strokeStyle = 'rgba(232,232,226,0.88)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'butt';
    ctx.stroke(w.leftEdge);
    ctx.stroke(w.rightEdge);

    this._drawFinishLine(ctx, w.W);
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
