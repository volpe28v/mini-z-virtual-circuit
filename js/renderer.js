// ワールド描画。パス (路面・縁石・ランオフ・白線・タイヤ痕) は設定変更時にだけ組み立て、毎フレームは塗るだけ。
import { cameraMatrix, viewRadiusMm, carGeometry } from './camera.js';
import { simulateRubber } from './marks.js';
import { TILE_MM } from './textures.js';
import { smokeSize, smokeAlpha } from './smoke.js';

const KERB_W = 18; // 縁石の幅 (mm)
const KERB_QUAD = 7; // 縁石 1 区画 = 7 サンプル (約 28mm)
const CORNER_K = 1 / 650; // この曲率より急な区間をコーナーとみなす
const RUNOFF_W = 55; // ランオフの最大幅 (mm)
const TUNNEL_WALL = 16; // トンネルの側壁の見える幅 (mm)
const TUNNEL_ROOF = 300; // 側壁の外側の、トンネルの上の構造物 (mm)
const BRIDGE_WATER = 420; // 橋の下の川: 路面の端から外側へ (mm)
const WATER_TILE_MM = 150;
const BEACH_SAND = 11; // 砂浜: 路面の端から波打ち際まで (mm)。縦持ちの画面では路面の外側は約 18mm しか見えない
const BEACH_WET = 4; // 波打ち際の濡れた砂
const BEACH_SEA = 520; // 海: 波打ち際から外側へ (mm。画面の外まで届く長さ)
const BEACH_TAPER = 380; // 砂浜の両端が草地へなじむ長さ (mm)
const SAND_TILE_MM = 60;
const PATH_STRIDE = 2; // 路面パスのサンプル間隔 (8mm)

export class Renderer {
  constructor(canvas, track, textures) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.scene = document.createElement('canvas');
    this.sctx = this.scene.getContext('2d', { alpha: false });
    this.tex = textures;
    this.pr = 1;
    this.cssW = 1;
    this.cssH = 1;
    this.patCache = new Map();
    this.world = null;
    this.marks = null;

    this.setTrack(track);
    this._tmp = {};
    this.smoke = null; // SmokeSystem (main.js が設定)
    this.skids = null; // SkidMarks (main.js が設定)
    this._skidPath = null;
    this._skidVersion = -1;
    this.smokeSprite = this._makeSmokeSprite();
    this.spraySprite = this._makeSmokeSprite([214, 228, 244]); // 雨の水煙 (青みがかった白)
    this.glowSprite = this._makeGlowSprite();
    this.glowCoolSprite = this._makeGlowSprite([226, 242, 238]); // 蛍光灯 (青白)
    this._t0 = 0;
  }

  // コースを差し替える (法線・コーナーを計算し直し、ワールドは次の描画で作り直す)
  setTrack(track) {
    this.track = track;
    this.theme = track.course ? track.course.theme : 'circuit';
    const N = track.N;
    this.nx = new Float64Array(N);
    this.ny = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.nx[i] = -Math.sin(track.theta[i]);
      this.ny[i] = Math.cos(track.theta[i]);
    }
    this.corners = this._findCorners();
    this.world = null;
    this.marks = null;
    this._skidPath = null;
    this._skidVersion = -1;
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

  // 街灯の光だまり (暖色の円形グラデーション。加算で重ねる)
  _makeGlowSprite(rgb) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    if (rgb) {
      const [R, G, B] = rgb;
      grad.addColorStop(0, `rgba(${R},${G},${B},0.9)`);
      grad.addColorStop(0.4, `rgba(${R},${G},${B},0.38)`);
      grad.addColorStop(1, `rgba(${R},${G},${B},0)`);
    } else {
      grad.addColorStop(0, 'rgba(255,238,200,1)');
      grad.addColorStop(0.12, 'rgba(255,222,160,0.8)');
      grad.addColorStop(0.45, 'rgba(255,196,120,0.28)');
      grad.addColorStop(1, 'rgba(255,180,100,0)');
    }
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
    // 地下駐車場の床は、使うときに作る (テクスチャも最初に必要になったとき生成される)
    for (const name of ['concrete', 'concreteDark']) {
      let v = null;
      Object.defineProperty(p, name, { get: () => (v ||= mk(this.tex[name], TILE_MM[name])), enumerable: true });
    }
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
      if (this.theme !== 'garage') runoffStrip(co, outside, co.a + 0.3 * L, co.b + 0.2 * L);
    }

    const puddles = this._buildPuddles(half);
    const lamps = this._buildLamps(half);
    const garage = this.theme === 'garage' ? this._buildGarage(half, W) : null;
    const tunnels = this._buildTunnels(half);
    const bridges = this._buildBridges(half);
    const beaches = this._buildBeaches(half);
    this.world = { tunnels, bridges, beaches, W, road, leftEdge, rightEdge, red, white, kerbOuter, kerbInner, runoff, puddles, lamps, garage };
    this.buildMarks(st);
  }

  // 吊り橋: 橋の下の川 (橋と直交して流れる)、橋の影、床板の継ぎ目、縁の桁、主ケーブルとハンガー、主塔と梁、両端の伸縮継手
  _buildBridges(half) {
    const t = this.track;
    const out = [];
    const strip = (p, a, b, d0, d1) => {
      for (let i = a; i <= b; i++) this._off(p, i, d0, i === a);
      for (let i = b; i >= a; i--) this._off(p, i, d1, false);
      p.closePath();
    };
    for (const br of t.bridges) {
      const a = br.i0;
      const b = br.i1;
      const o = { water: new Path2D(), shadow: new Path2D(), deck: new Path2D(), seams: new Path2D(), girder: new Path2D(), cables: new Path2D(), clamps: new Path2D(), towers: new Path2D(), beams: new Path2D(), plates: new Path2D() };
      const WL = half + BRIDGE_WATER;
      strip(o.water, a, b, -WL, WL);
      strip(o.shadow, a + 1, b - 1, -half + 18, half + 18); // 橋の影 (川面に落ちる。横にずれる)
      strip(o.deck, a, b, -half, half);
      for (let i = a + 4; i < b - 2; i += Math.round(60 / t.ds)) {
        this._off(o.seams, i, -half, true);
        this._off(o.seams, i, half, false);
      }
      const cx = half + 8; // 主ケーブルの位置 (路面の端のすぐ外)
      for (const side of [-1, 1]) {
        strip(o.girder, a, b, side * half, side * (half + 12));
        for (let i = a; i <= b; i++) this._off(o.cables, i, side * cx, i === a);
        // ハンガーの付け根 (上から見ると点)
        for (let i = a + 8; i < b - 6; i += Math.round(46 / t.ds)) {
          const j = ((i % t.N) + t.N) % t.N;
          const x = t.x[j] + this.nx[j] * side * cx;
          const y = t.y[j] + this.ny[j] * side * cx;
          o.clamps.moveTo(x + 2.2, y);
          o.clamps.arc(x, y, 2.2, 0, 6.2832);
        }
      }
      // 主塔: 両端の近くに、両側の柱 (四角) と、路面を横切る梁
      for (const ti of [a + 10, b - 10]) {
        for (const side of [-1, 1]) strip(o.towers, ti - 3, ti + 3, side * (half - 3), side * (half + 22));
        this._off(o.beams, ti, -half - 14, true);
        this._off(o.beams, ti, half + 14, false);
      }
      // 両端の伸縮継手 (鋼板)
      strip(o.plates, a, a + 3, -half - 12, half + 12);
      strip(o.plates, b - 3, b, -half - 12, half + 12);
      // 川の流れの向き (橋に直交) は、中央の位置の接線から決める
      const m = Math.round((a + b) / 2);
      o.mx = t.x[m];
      o.my = t.y[m];
      o.angle = (t.theta[m] * 180) / Math.PI;
      out.push(o);
    }
    return out;
  }

  // 砂浜と海: 路面の外側に、砂 → 濡れた砂 → 波打ち際 (泡) → 浅瀬 → 海。両端は草地へ細くなじむ
  _buildBeaches(half) {
    const t = this.track;
    const sm = (x) => {
      const u = Math.min(1, Math.max(0, x));
      return u * u * (3 - 2 * u);
    };
    return t.beaches.map((bc) => {
      const a = bc.i0;
      const b = bc.i1;
      const sg = bc.side;
      const edge = (i) => Math.min(i - a, b - i) * t.ds;
      const f = (i) => sm(edge(i) / BEACH_TAPER * 0.25); // 砂・波打ち際は両端の近くまで幅を保つ
      const fSea = (i) => sm(edge(i) / BEACH_TAPER); // 海の広がりはゆるやかに
      const o = { sand: new Path2D(), wetBand: new Path2D(), sea: new Path2D(), shallow: new Path2D(), a, b, sg, half, f };
      const strip = (p, d0, d1) => {
        for (let i = a; i <= b; i++) this._off(p, i, sg * d0(i), i === a);
        for (let i = b; i >= a; i--) this._off(p, i, sg * d1(i), false);
        p.closePath();
      };
      const shore = (i) => half + (BEACH_SAND + BEACH_WET) * f(i);
      strip(o.sand, () => half - 1, shore); // 濡れた砂の下も砂
      strip(o.wetBand, (i) => half + BEACH_SAND * f(i), shore);
      strip(o.sea, shore, (i) => shore(i) + BEACH_SEA * fSea(i));
      strip(o.shallow, shore, (i) => shore(i) + 12 * f(i));
      const m = (a + b) >> 1;
      o.mx = t.x[m];
      o.my = t.y[m];
      o.angle = (t.theta[m] * 180) / Math.PI;
      return o;
    });
  }

  // 砂のタイル (継ぎ目なし): 淡い黄土色に、細かい粒と風紋のむら
  _sandPattern(ctx) {
    if (this._sand) return this._sand;
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    let a = 777123;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    g.fillStyle = '#cdb98c';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 16; i++) {
      const x = rnd() * S;
      const y = rnd() * S;
      const r = 16 + rnd() * 26;
      const dark = rnd() < 0.5;
      for (const dx of [-S, 0, S]) {
        for (const dy of [-S, 0, S]) {
          const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
          gr.addColorStop(0, dark ? 'rgba(120,96,56,0.22)' : 'rgba(250,238,205,0.26)');
          gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr;
          g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
        }
      }
    }
    for (let i = 0; i < 900; i++) {
      const x = rnd() * S;
      const y = rnd() * S;
      const light = rnd() < 0.5;
      g.fillStyle = light ? `rgba(255,246,222,${(0.25 + rnd() * 0.35).toFixed(2)})` : `rgba(110,88,52,${(0.2 + rnd() * 0.3).toFixed(2)})`;
      const r = 0.35 + rnd() * 0.6;
      for (const dx of [-S, 0, S]) {
        for (const dy of [-S, 0, S]) g.fillRect(x + dx, y + dy, r, r);
      }
    }
    this._sand = ctx.createPattern(c, 'repeat');
    this._sandSize = S;
    return this._sand;
  }

  // 砂浜と海 (芝・砂利のあと、縁石・路面の前に描く)
  _drawBeaches(ctx) {
    const sandPat = this._sandPattern(ctx);
    const seaPat = this._waterPattern(ctx);
    const tsec = performance.now() / 1000;
    for (const o of this.world.beaches) {
      const { a, b, sg, half, f } = o;
      // 砂
      sandPat.setTransform(new DOMMatrix().scale(SAND_TILE_MM / this._sandSize));
      ctx.fillStyle = sandPat;
      ctx.fill(o.sand);
      // 海: 波は岸 (法線の向き) へ寄せる
      const swell = (tsec * 18) % WATER_TILE_MM;
      seaPat.setTransform(new DOMMatrix().translate(o.mx, o.my).rotate(o.angle).translate(0, -sg * swell).scale(WATER_TILE_MM / this._waterSize));
      ctx.fillStyle = seaPat;
      ctx.fill(o.sea);
      ctx.fillStyle = 'rgba(28,135,158,0.32)'; // 川より明るい青緑
      ctx.fill(o.sea);
      ctx.fillStyle = 'rgba(130,220,205,0.30)'; // 浅瀬
      ctx.fill(o.shallow);
      // 濡れた砂 (固定の帯)
      ctx.fillStyle = 'rgba(96,78,48,0.42)';
      ctx.fill(o.wetBand);
      // 寄せては引く波: 泡の線の位置が時間と場所でゆれる
      const tide = new Path2D();
      const foam = new Path2D();
      const foam2 = new Path2D();
      const base = (i) => half + (BEACH_SAND + BEACH_WET) * f(i);
      const wob = (i, k) => f(i) * (k * (BEACH_WET * 0.9) * Math.sin(tsec * 0.9 + i * 0.06) + 1.4 * Math.sin(tsec * 1.7 + i * 0.17 + 1.3));
      for (let i = a; i <= b; i += 2) this._off(tide, i, sg * (base(i) + wob(i, 1)), i === a);
      for (let i = b; i >= a; i -= 2) this._off(tide, i, sg * (half + BEACH_SAND * f(i)), false);
      tide.closePath();
      ctx.fillStyle = 'rgba(70,56,34,0.3)'; // 引いた後の濡れ跡
      ctx.fill(tide);
      for (let i = a; i <= b; i += 2) this._off(foam, i, sg * (base(i) + wob(i, 1)), i === a);
      for (let i = a; i <= b; i += 2) this._off(foam2, i, sg * (base(i) + wob(i, 1) + 3.5 * f(i) + 1.2 * f(i) * Math.sin(i * 0.4)), i === a);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(235,248,248,0.55)';
      ctx.lineWidth = 2.4;
      ctx.stroke(foam);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 0.9;
      ctx.stroke(foam);
      ctx.strokeStyle = 'rgba(225,245,245,0.28)';
      ctx.lineWidth = 1.4;
      ctx.stroke(foam2);
    }
  }

  // 川面のタイル (継ぎ目なし): 暗い青緑に、流れの向き (タイルの縦) に伸びた明暗の筋
  _waterPattern(ctx) {
    if (this._water) return this._water;
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    let a = 424242;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    g.fillStyle = '#25505e';
    g.fillRect(0, 0, S, S);
    // 大きな明暗のむら
    for (let i = 0; i < 14; i++) {
      const x = rnd() * S;
      const y = rnd() * S;
      const r = 18 + rnd() * 26;
      const dark = rnd() < 0.5;
      for (const dx of [-S, 0, S]) {
        for (const dy of [-S, 0, S]) {
          const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
          gr.addColorStop(0, dark ? 'rgba(8,28,38,0.35)' : 'rgba(80,140,150,0.22)');
          gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr;
          g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
        }
      }
    }
    // 流れの筋 (縦に細長い。端はタイルの反対側にも描いてつなぐ)
    g.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      const x = rnd() * S;
      const y = rnd() * S;
      const len = 6 + rnd() * 22;
      const light = rnd() < 0.62;
      g.strokeStyle = light ? `rgba(195,228,236,${(0.16 + rnd() * 0.3).toFixed(2)})` : `rgba(6,22,30,${(0.2 + rnd() * 0.25).toFixed(2)})`;
      g.lineWidth = light ? 0.8 + rnd() * 0.9 : 1.2 + rnd() * 1.4;
      for (const dx of [-S, 0, S]) {
        for (const dy of [-S, 0, S]) {
          g.beginPath();
          g.moveTo(x + dx, y + dy);
          g.quadraticCurveTo(x + dx + (rnd() - 0.5) * 4, y + dy + len / 2, x + dx + (rnd() - 0.5) * 3, y + dy + len);
          g.stroke();
        }
      }
    }
    this._water = ctx.createPattern(c, 'repeat');
    this._waterSize = S;
    return this._water;
  }

  // 橋の下の川と橋の影 (芝・砂利のあと、縁石・路面の前に描く)
  _drawBridgeWater(ctx) {
    const pat = this._waterPattern(ctx);
    const flow = ((performance.now() / 1000) * 24) % WATER_TILE_MM; // 川の流れ (mm/s)
    for (const o of this.world.bridges) {
      const s = WATER_TILE_MM / this._waterSize;
      // 流れは橋の中央の位置で、橋と直交する向き (タイルの縦 = 路面の横方向)
      pat.setTransform(new DOMMatrix().translate(o.mx, o.my).rotate(o.angle).translate(0, flow).scale(s));
      ctx.fillStyle = pat;
      ctx.fill(o.water);
      // 岸: 川の両端の縁 (橋のたもと)
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(70,62,48,0.75)';
      ctx.lineWidth = 7;
      ctx.stroke(o.water);
      ctx.strokeStyle = 'rgba(190,182,160,0.4)';
      ctx.lineWidth = 1.6;
      ctx.stroke(o.water);
      // 橋の影
      ctx.fillStyle = 'rgba(2,14,22,0.42)';
      ctx.fill(o.shadow);
    }
  }

  // 吊り橋の見た目 (路面の上に重ねる)
  _drawBridges(ctx) {
    for (const o of this.world.bridges) {
      // 床板: 鋼の板を並べた路面 (青みのある灰色を薄く重ね、約 60mm ごとの継ぎ目。上端に光、下端に影)
      ctx.fillStyle = 'rgba(112,124,138,0.22)';
      ctx.fill(o.deck, 'nonzero');
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(0,0,0,0.42)';
      ctx.lineWidth = 1.4;
      ctx.stroke(o.seams);
      ctx.save();
      ctx.translate(0.9, 0.9);
      ctx.strokeStyle = 'rgba(235,242,250,0.16)';
      ctx.lineWidth = 0.8;
      ctx.stroke(o.seams);
      ctx.restore();
      // 縁の桁 (鋼): 路面のすぐ外側。縁石や芝を隠す
      ctx.fillStyle = '#6d747c';
      ctx.fill(o.girder, 'nonzero');
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1.4;
      ctx.stroke(o.girder);
      // 両端の伸縮継手
      ctx.fillStyle = '#8a8f95';
      ctx.fill(o.plates, 'nonzero');
      ctx.strokeStyle = 'rgba(20,22,26,0.7)';
      ctx.lineWidth = 1.6;
      ctx.stroke(o.plates);
      // 主塔の影のあと、梁と柱
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.lineWidth = 7;
      ctx.save();
      ctx.translate(10, 10);
      ctx.stroke(o.beams);
      ctx.stroke(o.cables);
      ctx.restore();
      ctx.strokeStyle = '#4a5056';
      ctx.lineWidth = 5;
      ctx.stroke(o.beams);
      ctx.strokeStyle = 'rgba(210,216,222,0.5)';
      ctx.lineWidth = 1.4;
      ctx.stroke(o.beams);
      ctx.fillStyle = '#5b626a';
      ctx.fill(o.towers, 'nonzero');
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.2;
      ctx.stroke(o.towers);
      // 主ケーブル (太い鋼線) とハンガーの付け根
      ctx.strokeStyle = '#2f3438';
      ctx.lineWidth = 4.2;
      ctx.stroke(o.cables);
      ctx.strokeStyle = 'rgba(205,212,218,0.6)';
      ctx.lineWidth = 1.2;
      ctx.stroke(o.cables);
      ctx.fillStyle = '#8f979f';
      ctx.fill(o.clamps);
    }
  }

  // トンネル: 側壁、その外側 (上の構造物)、床の陰、継ぎ目、天井の照明の列、入口・出口の枠
  _buildTunnels(half) {
    const t = this.track;
    const out = [];
    const strip = (p, a, b, d0, d1) => {
      for (let i = a; i <= b; i++) this._off(p, i, d0, i === a);
      for (let i = b; i >= a; i--) this._off(p, i, d1, false);
      p.closePath();
    };
    for (const tu of t.tunnels) {
      const a = tu.i0;
      const b = tu.i1;
      const o = { wall: new Path2D(), roof: new Path2D(), shade: new Path2D(), edgeShade: new Path2D(), joints: new Path2D(), seams: new Path2D(), bars: new Path2D(), portals: new Path2D(), pts: [] };
      const w1 = half + TUNNEL_WALL;
      const w2 = w1 + TUNNEL_ROOF;
      strip(o.shade, a, b, -half, half);
      for (const side of [-1, 1]) {
        strip(o.wall, a, b, side * half, side * w1);
        strip(o.roof, a, b, side * w1, side * w2);
        strip(o.edgeShade, a, b, side * (half - 12), side * half);
      }
      // 上の構造物の継ぎ目 (約 220mm ごと) と、天井の照明の列 (約 380mm ごと)
      const jStep = Math.round(220 / t.ds);
      for (let i = a + jStep; i < b; i += jStep) {
        for (const side of [-1, 1]) {
          this._off(o.joints, i, side * w1, true);
          this._off(o.joints, i, side * w2, false);
        }
      }
      // 側壁のパネルの継ぎ目 (約 90mm ごと)
      const sStep = Math.round(90 / t.ds);
      for (let i = a + sStep; i < b; i += sStep) {
        for (const side of [-1, 1]) {
          this._off(o.seams, i, side * half, true);
          this._off(o.seams, i, side * w1, false);
        }
      }
      const bStep = Math.round(380 / t.ds);
      for (let i = a + Math.round(bStep / 2); i < b - 10; i += bStep) {
        this._off(o.bars, i, -half + 4, true);
        this._off(o.bars, i, half - 4, false);
      }
      // 入口・出口の枠 (厚み 40mm)
      const pl = Math.round(40 / t.ds);
      strip(o.portals, a, a + pl, -w2, w2);
      strip(o.portals, b - pl, b, -w2, w2);
      for (let i = a; i <= b; i += Math.round(40 / t.ds)) o.pts.push(t.x[i], t.y[i]);
      o.reach = half + TUNNEL_WALL;
      out.push(o);
    }
    return out;
  }

  // トンネルの中か (雨の波紋を消すために使う)
  _inTunnel(x, y) {
    for (const tu of this.world.tunnels) {
      const R2 = tu.reach * tu.reach;
      for (let i = 0; i < tu.pts.length; i += 2) {
        const dx = x - tu.pts[i];
        const dy = y - tu.pts[i + 1];
        if (dx * dx + dy * dy < R2) return true;
      }
    }
    return false;
  }

  // トンネルの見た目 (路面の上に重ねる): 床の陰 → 上の構造物 (コンクリート) → 側壁 → 入口・出口の枠
  _drawTunnels(ctx, P) {
    for (const tu of this.world.tunnels) {
      ctx.fillStyle = 'rgba(2,4,12,0.34)';
      ctx.fill(tu.shade);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fill(tu.edgeShade, 'nonzero');
      // 上の構造物: 暗いコンクリートに継ぎ目
      ctx.fillStyle = P.concreteDark;
      ctx.fill(tu.roof, 'nonzero');
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fill(tu.roof, 'nonzero');
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1.6;
      ctx.stroke(tu.joints);
      // 側壁: 明るめのコンクリートの面 (上から見ると細い帯) と、立体感の縁
      ctx.fillStyle = '#7b7d82';
      ctx.fill(tu.wall, 'nonzero');
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.9;
      ctx.stroke(tu.seams);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1.2;
      ctx.stroke(tu.wall);
      // 入口・出口の枠
      ctx.fillStyle = '#9b9a93';
      ctx.fill(tu.portals, 'nonzero');
      ctx.strokeStyle = 'rgba(20,20,22,0.7)';
      ctx.lineWidth = 2;
      ctx.stroke(tu.portals);
    }
  }

  // トンネルの天井の照明: 夜の暗さの上に、加算で光らせる。細い明るい線の周りに、幅の違う弱い線を重ねてなめらかに広げる
  _drawTunnelLights(ctx, m) {
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'butt';
    const layers = [
      [64, 0.025, '255,170,80'],
      [44, 0.03, '255,176,90'],
      [28, 0.04, '255,186,100'],
      [14, 0.06, '255,200,120'],
      [6, 0.12, '255,226,170'],
      [1.8, 0.8, '255,244,210'],
    ];
    for (const tu of this.world.tunnels) {
      for (const [w, a, c] of layers) {
        ctx.strokeStyle = `rgba(${c},${a})`;
        ctx.lineWidth = w;
        ctx.stroke(tu.bars);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // 街灯: コースの外側に、左右交互に一定間隔で置く (夜の光だまり用)。[x0, y0, x1, y1, ...]
  _buildLamps(half) {
    const t = this.track;
    const out = [];
    if (this.theme === 'garage') {
      // 天井の蛍光灯: 通路の中心に沿って一定間隔 (x, y, 向き)。縦横の通路が交わる所だけ間引く必要はない
      const step = Math.round(430 / t.ds);
      for (let i = 0; i < t.N; i += step) out.push(t.x[i], t.y[i], t.theta[i]);
      return out;
    }
    const step = Math.round(520 / t.ds);
    for (let i = 0, n = 0; i < t.N; i += step, n++) {
      if (t.tunnels.some((tu) => i >= tu.i0 && i <= tu.i1)) continue; // トンネルの中は天井の照明
      if (t.bridges.some((br) => i >= br.i0 - 10 && i <= br.i1 + 10)) continue; // 橋の脇は川
      const side = n & 1 ? 1 : -1;
      if (t.beaches.some((bc) => bc.side === side && i >= bc.i0 - 10 && i <= bc.i1 + 10)) continue; // 砂浜の側には街灯が無い
      const d = side * (half + KERB_W + 22);
      out.push(t.x[i] + this.nx[i] * d, t.y[i] + this.ny[i] * d);
    }
    return out;
  }

  // 地下駐車場: 通路の両側の駐車車両と、5 番の目に並ぶ柱。固定の種で作るので毎回同じ
  _buildGarage(half, W) {
    const t = this.track;
    const depth = 110; // 駐車枠の奥行き (mm)
    const margin = 8;
    const stall = 62; // 駐車枠の幅 (mm)
    let a = 77031;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const COLORS = ['#c9ccd2', '#2b2e36', '#8d1f26', '#d9d6cc', '#27456e', '#5b6068', '#b58a2a', '#e8e8ea'];
    const bodies = COLORS.map(() => new Path2D());
    const roofs = new Path2D();
    const glass = new Path2D();
    const lines = new Path2D();
    const stripe = (p, cx, cy, ux, uy, vx, vy, hu, hv) => {
      // 中心 (cx, cy)、u 方向の半長 hu、v 方向の半長 hv の長方形
      p.moveTo(cx - ux * hu - vx * hv, cy - uy * hu - vy * hv);
      p.lineTo(cx + ux * hu - vx * hv, cy + uy * hu - vy * hv);
      p.lineTo(cx + ux * hu + vx * hv, cy + uy * hu + vy * hv);
      p.lineTo(cx - ux * hu + vx * hv, cy - uy * hu + vy * hv);
      p.closePath();
    };
    const sc = t.course.scale;
    const pillars = [];
    for (const [px, py] of t.course.pillars || []) pillars.push(px * sc, py * sc);
    const near = Math.round(130 / t.ds);
    const skip = Math.round(stall / t.ds);
    const off = half + margin + depth / 2;
    let count = 0;
    for (let i = 0; i < t.N; i += skip) {
      // 直線部だけ (曲がりの途中には置かない)
      let straight = true;
      for (let d = -22; d <= 22; d += 4) {
        if (Math.abs(t.kappa[(i + d + t.N) % t.N]) > 1 / 2500) {
          straight = false;
          break;
        }
      }
      if (!straight) continue;
      const tx = Math.cos(t.theta[i]);
      const ty = Math.sin(t.theta[i]);
      for (const side of [-1, 1]) {
        const cx = t.x[i] + this.nx[i] * side * off;
        const cy = t.y[i] + this.ny[i] * side * off;
        // 他の通路 (弧の距離が離れた中心線) までの最短距離
        let dmin = Infinity;
        for (let j = 0; j < t.N; j += 2) {
          let dj = Math.abs(j - i);
          dj = Math.min(dj, t.N - dj);
          if (dj < near) continue;
          const dd = Math.hypot(t.x[j] - cx, t.y[j] - cy);
          if (dd < dmin) dmin = dd;
        }
        if (dmin < half + depth / 2 + 4) continue; // 隣の通路に重なる
        let hitPillar = false;
        for (let p = 0; p < pillars.length; p += 2) {
          if (Math.hypot(pillars[p] - cx, pillars[p + 1] - cy) < 85) hitPillar = true;
        }
        if (hitPillar) continue;
        // 駐車枠の白線 (道路の端から奥へ)
        const lx = t.x[i] + this.nx[i] * side * (half + margin) + tx * (stall / 2);
        const ly = t.y[i] + this.ny[i] * side * (half + margin) + ty * (stall / 2);
        lines.moveTo(lx, ly);
        lines.lineTo(lx + this.nx[i] * side * depth, ly + this.ny[i] * side * depth);
        if (rnd() < 0.18) continue; // 空き枠
        const ci = Math.floor(rnd() * COLORS.length);
        const nose = rnd() < 0.5 ? 1 : -1; // 頭から入れた車と、バックで入れた車
        const hl = depth / 2 - 2; // 車の半長 (通路に直角)
        const hw = (stall - 8) / 2; // 車の半幅
        // 車の向きは、通路に直角 (u = 通路の外向き、v = 通路方向)
        const ux = this.nx[i] * side;
        const uy = this.ny[i] * side;
        stripe(bodies[ci], cx, cy, ux, uy, tx, ty, hl, hw);
        stripe(roofs, cx - ux * nose * hl * 0.05, cy - uy * nose * hl * 0.05, ux, uy, tx, ty, hl * 0.42, hw * 0.78);
        stripe(glass, cx + ux * nose * hl * 0.5, cy + uy * nose * hl * 0.5, ux, uy, tx, ty, hl * 0.13, hw * 0.74);
        stripe(glass, cx - ux * nose * hl * 0.5, cy - uy * nose * hl * 0.5, ux, uy, tx, ty, hl * 0.1, hw * 0.7);
        count++;
      }
    }
    return { bodies, colors: COLORS, roofs, glass, lines, pillars, count, depth };
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

    const garage = this.theme === 'garage';
    // 芝 (大きな色むらはタイルに焼き込み済み)。地下駐車場は暗いコンクリートの床
    ctx.fillStyle = garage ? P.concreteDark : P.grass;
    ctx.fillRect(gx, gy, 2 * r, 2 * r);

    if (!garage) {
      // ランオフ (砂利)
      ctx.fillStyle = P.gravel;
      ctx.fill(w.runoff);
      ctx.strokeStyle = 'rgba(30,24,16,0.35)';
      ctx.lineWidth = 1.2;
      ctx.stroke(w.runoff);
    }
    if (w.beaches.length) this._drawBeaches(ctx);
    if (w.bridges.length) this._drawBridgeWater(ctx);

    const wet = Math.min(1, Math.max(0, st.wet || 0));
    // 縁石 (赤白) + 汚れ + 立体感の線
    ctx.fillStyle = garage ? '#e0b01c' : '#c4272c'; // 地下駐車場は黄黒のポールガード
    ctx.fill(w.red);
    ctx.fillStyle = garage ? '#25272c' : '#e9e6de';
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
    ctx.fillStyle = garage ? P.concrete : P.asphalt;
    ctx.fill(w.road, 'evenodd');
    if (garage) this._drawGarageFloor(ctx, w.garage);
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

    if (w.tunnels.length) this._drawTunnels(ctx, P);
    if (w.bridges.length) this._drawBridges(ctx);
    this._drawFinishLine(ctx, w.W);
    if (!garage && st.jump > 0) this._drawJumpMarks(ctx, w.W);
    if (garage) this._drawPillars(ctx, w.garage);
    if (!this._overview && this.smoke && st.smoke > 0) this._drawSmoke(ctx, cam, r, wet);
    if (!this._overview) this._drawLighting(ctx, cam, st, w, r, m, wet);
    const rain = Math.min(1, Math.max(0, st.rain ?? st.wet ?? 0));
    if (rain > 0.2 && !this._overview) this._drawRain(ctx, cam, r, rain);
    if (w.tunnels.length) this._drawTunnelLights(ctx, m);
    if (!this._overview && this.smoke) this._drawSparks(ctx, m);
  }

  // 地下駐車場の床: 駐車枠の線、駐車している車。柱は縁石のあとで描く (_drawPillars)
  _drawGarageFloor(ctx, g) {
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(232,232,224,0.5)';
    ctx.lineWidth = 1.4;
    ctx.stroke(g.lines);
    // 影 (少しずらした暗い塊) → 車体 → ルーフ → ガラス
    ctx.save();
    ctx.translate(3, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    for (const p of g.bodies) ctx.fill(p);
    ctx.restore();
    for (let i = 0; i < g.bodies.length; i++) {
      ctx.fillStyle = g.colors[i];
      ctx.fill(g.bodies[i]);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.fill(g.roofs);
    ctx.fillStyle = 'rgba(14,18,26,0.86)';
    ctx.fill(g.glass);
  }

  _drawPillars(ctx, g) {
    const S = 58; // 柱の一辺 (mm)
    for (let i = 0; i < g.pillars.length; i += 2) {
      const x = g.pillars[i];
      const y = g.pillars[i + 1];
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(x - S / 2 + 4, y - S / 2 + 4, S, S);
      ctx.fillStyle = '#8b8d92';
      ctx.fillRect(x - S / 2, y - S / 2, S, S);
      ctx.fillStyle = '#e0b01c';
      for (const [dx, dy] of [[-S / 2, -S / 2], [S / 2 - 6, -S / 2], [-S / 2, S / 2 - 6], [S / 2 - 6, S / 2 - 6]]) {
        ctx.fillRect(x + dx, y + dy, 6, 6);
      }
      ctx.strokeStyle = 'rgba(40,40,44,0.7)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - S / 2, y - S / 2, S, S);
    }
  }

  // 夕方・夜: 全体を暗く色づけ (ヘッドライトの届く範囲だけ明るく残す)、街灯の光だまり、濡れた路面への反射
  _drawLighting(ctx, cam, st, w, viewR, m, wet) {
    const dark = Math.min(1, Math.max(0, st.dark || 0));
    const warm = Math.min(1, Math.max(0, st.warm || 0));
    if (dark < 0.01 && warm < 0.01) return;
    const k = cam.k * this.pr;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const on = Math.min(1, Math.max(0, (dark - 0.3) / 0.5)); // ヘッドライトの点き具合

    // 色: 夜は暗い青、夕焼け・朝焼けは赤みを混ぜる。暗さ (alpha) と色味は 1 回の塗りにまとめる
    const wm = warm / (warm + dark * 0.8 + 1e-6);
    const col = [8 + 142 * wm, 14 + 50 * wm, 36 - 6 * wm].map((v) => Math.round(v));
    const a = Math.min(0.88, 0.86 * dark + 0.18 * warm);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 光の中心: 車の前方 (画面の上) 約 120mm
    const cx = cam.ax * this.pr;
    const cy = cam.ay * this.pr - 120 * k;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 200 * k);
    const aIn = a * (1 - 0.7 * on);
    g.addColorStop(0, `rgba(${col},${aIn.toFixed(3)})`);
    g.addColorStop(1, `rgba(${col},${a.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = 'lighter';
    // ヘッドライトの光 (暖色) と、濡れた路面への縦長の反射
    if (on > 0.01) {
      const bx = cam.ax * this.pr;
      const by = cam.ay * this.pr - 110 * k;
      const rr = 170 * k;
      const hg = ctx.createRadialGradient(bx, by, 0, bx, by, rr);
      hg.addColorStop(0, `rgba(255,238,200,${(0.22 * on).toFixed(3)})`);
      hg.addColorStop(1, 'rgba(255,238,200,0)');
      ctx.fillStyle = hg;
      ctx.fillRect(bx - rr, by - rr, 2 * rr, 2 * rr);
      if (wet > 0.05) {
        ctx.save();
        ctx.translate(bx, by);
        ctx.scale(0.28, 1);
        const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, rr * 1.1);
        sg.addColorStop(0, `rgba(210,230,255,${(0.34 * on * wet).toFixed(3)})`);
        sg.addColorStop(1, 'rgba(210,230,255,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(-rr * 1.2, -rr * 1.2, rr * 2.4, rr * 2.4);
        ctx.restore();
      }
    }
    // 街灯の光だまり (路面に固定、路面と一緒に流れる)。濡れていると強く反射する
    const lampA = Math.min(1, dark * 1.3) * (0.55 + 0.45 * wet);
    if (st.indoor && lampA > 0.02) {
      // 天井の蛍光灯: 通路に沿って細長い、青白い光だまり。ときどき短くちらつく
      const t = performance.now() / 1000;
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      const L = w.lamps;
      const RX = 105;
      const RY = 70;
      for (let i = 0, n = 0; i < L.length; i += 3, n++) {
        if (Math.abs(L[i] - cam.px) > viewR + RX || Math.abs(L[i + 1] - cam.py) > viewR + RX) continue;
        const flick = (t * 2.3 + n * 1.713) % 9 < 0.1 ? 0.35 : 1;
        ctx.globalAlpha = lampA * 0.8 * flick;
        ctx.save();
        ctx.translate(L[i], L[i + 1]);
        ctx.rotate(L[i + 2]);
        ctx.drawImage(this.glowCoolSprite, -RX, -RY, 2 * RX, 2 * RY);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    } else if (lampA > 0.02) {
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.globalAlpha = lampA;
      const R = 80 * (1 + 0.25 * wet);
      const L = w.lamps;
      for (let i = 0; i < L.length; i += 2) {
        if (Math.abs(L[i] - cam.px) > viewR + R || Math.abs(L[i + 1] - cam.py) > viewR + R) continue;
        ctx.drawImage(this.glowSprite, L[i] - R, L[i + 1] - R, 2 * R, 2 * R);
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
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
    const hasTunnel = this.world.tunnels.length > 0;
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
        if (hasTunnel && this._inTunnel(x, y)) continue; // トンネルの中は雨が降らない
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

  // 着地の火花: 夜の暗さの上に、加算で明るく描く。細かい粒を大量に、粒ごとに明るさと長さを変える。
  // 線の太さは 0.6〜1.4mm (画面で数 px) の細い線 + 先端の小さな点。明るさを 4 段階にまとめて、描画の呼び出しを減らす
  _drawSparks(ctx, m) {
    const S = this.smoke;
    if (S.sparkCount === 0) return;
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const LV = 4;
    for (let lv = 0; lv < LV; lv++) {
      const lo = lv / LV;
      const hi = (lv + 1) / LV;
      const aMid = (lo + hi) / 2;
      const glow = new Path2D();
      const core = new Path2D();
      const heads = new Path2D();
      let any = false;
      for (let i = 0; i < S.sx.length; i++) {
        if (S.slife[i] <= 0) continue;
        const fade = 1 - S.sage[i] / S.slife[i];
        const t = Math.min(1, 1.5 * fade) * (0.45 + 0.55 * S.sbr[i]);
        if (t < lo || t >= hi + (lv === LV - 1 ? 1 : 0)) continue;
        any = true;
        const x = S.sx[i];
        const y = S.sy[i];
        const len = 0.03 + 0.03 * S.sbr[i];
        const tx = x - S.svx[i] * len;
        const ty = y - S.svy[i] * len;
        glow.moveTo(x, y);
        glow.lineTo(tx, ty);
        core.moveTo(x, y);
        core.lineTo(x + (tx - x) * 0.5, y + (ty - y) * 0.5);
        if (S.sbr[i] > 0.6) {
          heads.moveTo(x + 0.9, y);
          heads.arc(x, y, 0.9, 0, 6.2832);
        }
      }
      if (!any) continue;
      ctx.strokeStyle = `rgba(255,130,35,${Math.min(1, aMid * 0.95 + 0.1).toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.stroke(glow);
      ctx.strokeStyle = `rgba(255,236,170,${Math.min(1, aMid + 0.1).toFixed(3)})`;
      ctx.lineWidth = 0.65;
      ctx.stroke(core);
      ctx.fillStyle = `rgba(255,248,215,${Math.min(1, aMid + 0.1).toFixed(3)})`;
      ctx.fill(heads);
    }
    ctx.globalCompositeOperation = 'source-over';
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

  // ジャンプ台 (路面の段差): 踏み切りに、暗い帯と黄色い斜線の注意マーク
  _drawJumpMarks(ctx, W) {
    for (const j of this.track.jumps) {
      const c = this.track.at(j.s, this._tmp);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.theta);
      ctx.fillStyle = 'rgba(20,20,22,0.16)';
      ctx.fillRect(-14, -W / 2, 28, W);
      ctx.strokeStyle = 'rgba(244,238,226,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-14, -W / 2);
      ctx.lineTo(-14, W / 2);
      ctx.moveTo(14, -W / 2);
      ctx.lineTo(14, W / 2);
      ctx.stroke();
      // 注意の斜線 (道の両端)
      ctx.fillStyle = 'rgba(238,190,40,0.7)';
      const n = 3;
      const sw = W * 0.12;
      for (const side of [-1, 1]) {
        for (let i = 0; i < n; i++) {
          const y0 = side * (W / 2 - sw * (i + 1));
          ctx.beginPath();
          ctx.moveTo(-8, y0);
          ctx.lineTo(8, y0 + side * sw * 0.5);
          ctx.lineTo(8, y0 + side * sw * 0.9);
          ctx.lineTo(-8, y0 + side * sw * 0.4);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }
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
