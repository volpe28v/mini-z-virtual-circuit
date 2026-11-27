// コース形状。ワールド座標は mm、y は下向き、角度は atan2(y, x) 基準 (東 = 0、時計回りが正)。
// 左コーナーは角度が減る = 曲率 κ < 0。法線 N = (-sin θ, cos θ) は κ > 0 のとき曲がる中心側を向く。

export const SAMPLE_STEP = 4; // 再サンプル間隔 (mm)
const DENSE_STEP = 2; // 折れ線生成の間隔 (mm)
const SMOOTH_SIGMA = 40; // 位置の平滑化 (mm)
const KAPPA_SIGMA = 25; // 曲率の平滑化 (mm)
const KAPPA0 = 1 / 900; // この曲率より緩ければ全速
const U_MIN = 0.3;
const BRAKE = 0.0008; // u² の減少率 / mm
const ACCEL = 0.00065;

const DEG = Math.PI / 180;

export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// ---- コース形状: 提供されたコース図 (①〜⑨ の番号付き) をなぞった制御点 ----
// 座標は図の px (y 下向き)。START はメインストレート (下辺) 上で、①→⑨ の順に時計回りに走る。
const SKETCH_SCALE = 6.5; // mm / px (全長 約 13m、最小半径 約 170mm)
const CONTROL_POINTS = [
  [170, 517], [130, 517], [100, 515], // START → ① へ (下辺を左向き)
  [70, 508], [45, 488], [30, 458], [24, 420], [24, 380], [24, 350], // ① 左下の右コーナー、左辺を北へ
  [26, 340], [32, 324], [46, 313], [68, 313], [92, 325], [116, 338], [140, 336], [160, 320], // ② 左辺の山形
  [178, 300], [194, 280], [206, 252], [212, 222], [212, 192], // ③ 斜め→まっすぐ北へ
  [204, 160], [188, 130], [180, 100], [186, 72], [203, 48], [225, 32], [246, 32], // ④ 上へ膨らむ大きな右コーナー
  [272, 48], [298, 62], [322, 76], [350, 95], [376, 97], // ⑤ 斜めの直線と小さな段
  [400, 106], [440, 128], [481, 151], [495, 167], [495, 189], [481, 206], [459, 209], // ⑥ 右端のヘアピン (R≈190mm)
  [430, 207], [395, 200], [365, 197], [342, 212], [325, 238], // ⑦ 折り返し後の緩い曲がり
  [300, 275], [278, 312], [262, 345], [255, 375], [262, 405], [282, 424], [310, 431], // ⑧ 斜めの下りと左のヘアピン気味のコーナー
  [350, 430], [390, 429], [425, 433], [448, 450], [452, 478], [440, 503], [418, 516], [390, 518], [350, 517], [260, 517], // ⑨ 右下の 180° コーナー、メインストレートへ
];

// centripetal Catmull-Rom (alpha = 0.5)。閉ループ
function catmullRomClosed(pts, step) {
  const n = pts.length;
  const out = [];
  const knot = (t, a, b) => t + Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const t0 = 0;
    const t1 = knot(t0, p0, p1);
    const t2 = knot(t1, p1, p2);
    const t3 = knot(t2, p2, p3);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(1, Math.round(segLen / step));
    for (let j = 0; j < m; j++) {
      const t = t1 + ((t2 - t1) * j) / m;
      const lerp2 = (a, b, ta, tb) => {
        const k = (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      };
      const A1 = lerp2(p0, p1, t0, t1);
      const A2 = lerp2(p1, p2, t1, t2);
      const A3 = lerp2(p2, p3, t2, t3);
      const B1 = lerp2(A1, A2, t0, t2);
      const B2 = lerp2(A2, A3, t1, t3);
      out.push(lerp2(B1, B2, t1, t2));
    }
  }
  return out;
}

function buildDensePolyline() {
  const pts = CONTROL_POINTS.map(([x, y]) => [x * SKETCH_SCALE, y * SKETCH_SCALE]);
  return catmullRomClosed(pts, DENSE_STEP);
}

function gaussKernel(sigmaSamples) {
  const r = Math.ceil(sigmaSamples * 3);
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigmaSamples * sigmaSamples));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, r };
}

// 周期配列に対するガウス平滑
function smoothPeriodic(arr, sigmaSamples) {
  const n = arr.length;
  const { k, r } = gaussKernel(sigmaSamples);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) {
      acc += arr[(((i + j) % n) + n) % n] * k[j + r];
    }
    out[i] = acc;
  }
  return out;
}

export class Track {
  constructor() {
    const dense = buildDensePolyline();
    const n0 = dense.length;
    let xs = Float64Array.from(dense, (p) => p[0]);
    let ys = Float64Array.from(dense, (p) => p[1]);
    const sigma = SMOOTH_SIGMA / DENSE_STEP;
    xs = smoothPeriodic(xs, sigma);
    ys = smoothPeriodic(ys, sigma);

    // 等間隔に再サンプル
    const cum = new Float64Array(n0 + 1);
    for (let i = 0; i < n0; i++) {
      const j = (i + 1) % n0;
      cum[i + 1] = cum[i] + Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
    }
    const total = cum[n0];
    const N = Math.round(total / SAMPLE_STEP);
    const ds = total / N;
    this.N = N;
    this.ds = ds;
    this.length = total;
    this.x = new Float64Array(N);
    this.y = new Float64Array(N);
    let seg = 0;
    for (let i = 0; i < N; i++) {
      const target = i * ds;
      while (seg < n0 - 1 && cum[seg + 1] < target) seg++;
      const j = (seg + 1) % n0;
      const t = (target - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
      this.x[i] = xs[seg] + (xs[j] - xs[seg]) * t;
      this.y[i] = ys[seg] + (ys[j] - ys[seg]) * t;
    }

    // 接線角 (アンラップ) と曲率
    const theta = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i + 1) % N;
      const b = (i - 1 + N) % N;
      theta[i] = Math.atan2(this.y[a] - this.y[b], this.x[a] - this.x[b]);
    }
    for (let i = 1; i < N; i++) {
      theta[i] = theta[i - 1] + wrapAngle(theta[i] - theta[i - 1]);
    }
    this.theta = theta;
    this.totalTurn = theta[N - 1] + wrapAngle(theta[0] - theta[N - 1]) - theta[0];

    const kraw = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i + 1) % N;
      const b = (i - 1 + N) % N;
      kraw[i] = wrapAngle(this.thetaWrapped(a) - this.thetaWrapped(b)) / (2 * ds);
    }
    this.kappa = smoothPeriodic(kraw, KAPPA_SIGMA / ds);

    this.speedU = this.buildProfile();

    // S/F ライン: 折れ線の始点 (= コース図の START)。少し手前から走り出す
    this.finishS = 0;
    this.startS = this.length - 150;
  }

  thetaWrapped(i) {
    return this.theta[i];
  }

  buildProfile() {
    const { N, ds, kappa } = this;
    let u = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const k = Math.max(Math.abs(kappa[i]), 1e-9);
      u[i] = Math.min(1, Math.max(U_MIN, Math.sqrt(KAPPA0 / k)));
    }
    // 減速 (後ろ向き)、加速 (前向き)。周回の値が合うよう 2 周走査する
    for (let c = 0; c < 2 * N; c++) {
      const i = (N - 1 - (c % N)) % N;
      const j = (i + 1) % N;
      u[i] = Math.min(u[i], Math.sqrt(u[j] * u[j] + 2 * BRAKE * ds));
    }
    for (let c = 0; c < 2 * N; c++) {
      const i = c % N;
      const j = (i - 1 + N) % N;
      u[i] = Math.min(u[i], Math.sqrt(u[j] * u[j] + 2 * ACCEL * ds));
    }
    u = smoothPeriodic(u, 30 / ds);
    for (let i = 0; i < N; i++) u[i] = Math.min(1, Math.max(U_MIN, u[i]));
    return u;
  }

  // s (mm、無限に増えてよい) の位置。out を渡すとオブジェクトを再利用する。
  at(s, out = {}) {
    const { N, ds } = this;
    let f = s / ds;
    f -= Math.floor(f / N) * N;
    const i = Math.floor(f);
    const t = f - i;
    const j = (i + 1) % N;
    out.x = this.x[i] + (this.x[j] - this.x[i]) * t;
    out.y = this.y[i] + (this.y[j] - this.y[i]) * t;
    // 周回の継ぎ目では θ が 2π ずれるので、差を折り返して補間する
    out.theta = this.theta[i] + wrapAngle(this.theta[j] - this.theta[i]) * t;
    out.kappa = this.kappa[i] + (this.kappa[j] - this.kappa[i]) * t;
    return out;
  }

  kappaAt(s) {
    const { N, ds } = this;
    let f = s / ds;
    f -= Math.floor(f / N) * N;
    const i = Math.floor(f);
    const t = f - i;
    return this.kappa[i] + (this.kappa[(i + 1) % N] - this.kappa[i]) * t;
  }

  speedAt(s) {
    const { N, ds } = this;
    let f = s / ds;
    f -= Math.floor(f / N) * N;
    const i = Math.floor(f);
    const t = f - i;
    return this.speedU[i] + (this.speedU[(i + 1) % N] - this.speedU[i]) * t;
  }

  // バウンディングボックス
  bounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.N; i++) {
      minX = Math.min(minX, this.x[i]);
      maxX = Math.max(maxX, this.x[i]);
      minY = Math.min(minY, this.y[i]);
      maxY = Math.max(maxY, this.y[i]);
    }
    return { minX, minY, maxX, maxY };
  }
}
