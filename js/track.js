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

// ---- コース定義 ----
// points: 図の px (y 下向き) の制御点。scale: mm / px。theme / indoor は描画側が見る。
// ridge: 提供されたコース図 (①〜⑨ の番号付き) をなぞったもの。
// garage: 地下駐車場。5 番の目に並ぶ柱のあいだを、90° のコーナーの連続で抜ける十字形のループ (東京ドリフト風)。
// 座標は図の px (y 下向き)。START はメインストレート (下辺) 上で、①→⑨ の順に時計回りに走る。
const SKETCH_SCALE = 6.5;
// ジャンプ台 (図の px): ⑦ と ⑧ の間の斜めの下り。踏み切りの位置
const RIDGE_JUMPS = [[321, 244]];
// トンネル (図の px の [入口, 出口]): ① の入り口 (図の ① の枠の右端) から ② の手前まで。左辺を北へ向かう区間
// 吊り橋 (図の px の [入口, 出口]): ② の出口から ③ の入り口まで。ほぼ直線の斜めの区間
const RIDGE_BRIDGES = [[[155, 325], [192, 284]]];
const RIDGE_TUNNELS = [
  [[105, 516], [24, 362]], // ① 入り口 → ② の手前
  [[269, 329], [310, 431]], // ⑧ のカーブが始まる直前 → コーナーの出口
]; // 図の px (全長 約 13m、最小半径 約 170mm)
const RIDGE_POINTS = [
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

// 地下駐車場: 3×3 の区画の境目の線をたどる十字形のループで、
// 90° のコーナーが 12 個連続する (右・左・右・右・左・右・右・左・右・右・左・右)。
// 四隅の柱は 4 つの凹みの角の内側にあり、コースが柱をなめるように曲がる。中央の柱は十字の内側の真ん中。
const GARAGE_CELL = 140; // 1 区画 (px)。140px = 910mm
const GARAGE_RADIUS = 30; // コーナーの半径 (px)。30px = 195mm
const GARAGE_LOOP = [
  [1, 0], [2, 0], [2, 1], [3, 1], [3, 2], [2, 2], [2, 3], [1, 3], [1, 2], [0, 2], [0, 1], [1, 1],
].map(([x, y]) => [x * GARAGE_CELL, y * GARAGE_CELL]);
// 柱: 5 番の目 (四隅 + 中央)。四隅の柱は、4 つの凹みの角 (左折) の曲率の中心に置く (コースが柱をなめるように曲がる)。
// 中央の柱は、十字の内側 (インフィールド) の真ん中。
const GARAGE_PILLARS = [
  ...[[1, 1, -1, -1], [2, 1, 1, -1], [2, 2, 1, 1], [1, 2, -1, 1]].map(([x, y, sx, sy]) => [
    x * GARAGE_CELL + sx * GARAGE_RADIUS,
    y * GARAGE_CELL + sy * GARAGE_RADIUS,
  ]),
  [1.5 * GARAGE_CELL, 1.5 * GARAGE_CELL],
];

// 多角形の角を円弧で丸めた制御点 (閉ループ)。直線部にも点を置いて、Catmull-Rom が直線から外れないようにする
function roundedLoop(verts, r, straightStep) {
  const n = verts.length;
  const out = [];
  const unit = (a, b) => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
  };
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n];
    const v = verts[i];
    const next = verts[(i + 1) % n];
    const din = unit(prev, v);
    const dout = unit(v, next);
    const pin = [v[0] - din[0] * r, v[1] - din[1] * r];
    // 円弧の中心は、入口から進行方向の横 (曲がる側) へ r
    const cross = din[0] * dout[1] - din[1] * dout[0]; // > 0 は右折 (y 下向き)
    const side = cross > 0 ? [-din[1], din[0]] : [din[1], -din[0]];
    const center = [pin[0] + side[0] * r, pin[1] + side[1] * r];
    const a0 = Math.atan2(pin[1] - center[1], pin[0] - center[0]);
    const turn = cross > 0 ? Math.PI / 2 : -Math.PI / 2;
    for (let k = 0; k <= 4; k++) {
      const a = a0 + (turn * k) / 4;
      out.push([center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r]);
    }
    // このコーナーの出口から次のコーナーの入口までの直線
    const pout = [v[0] + dout[0] * r, v[1] + dout[1] * r];
    const nn = verts[(i + 2) % n];
    const dn = unit(next, nn);
    const nextIn = [next[0] - dout[0] * r, next[1] - dout[1] * r];
    void dn;
    const len = Math.hypot(nextIn[0] - pout[0], nextIn[1] - pout[1]);
    const m = Math.max(0, Math.round(len / straightStep) - 1);
    for (let k = 1; k <= m; k++) {
      const f = k / (m + 1);
      out.push([pout[0] + (nextIn[0] - pout[0]) * f, pout[1] + (nextIn[1] - pout[1]) * f]);
    }
  }
  return out;
}
const GARAGE_POINTS = (() => {
  const pts = roundedLoop(GARAGE_LOOP, GARAGE_RADIUS, 40);
  return [...pts.slice(5), ...pts.slice(0, 5)]; // 最初の点 = 上の辺 (十字の上の腕の先端) の中ほど
})();

export const COURSES = {
  ridge: { id: 'ridge', name: 'Ridge 風サーキット', points: RIDGE_POINTS, scale: SKETCH_SCALE, theme: 'circuit', indoor: false, jumps: RIDGE_JUMPS, tunnels: RIDGE_TUNNELS, bridges: RIDGE_BRIDGES },
  garage: { id: 'garage', name: '地下駐車場 (ドリフト)', points: GARAGE_POINTS, scale: 6.5, theme: 'garage', indoor: true, pillars: GARAGE_PILLARS },
};
export const COURSE_IDS = Object.keys(COURSES);

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

function buildDensePolyline(course) {
  const pts = course.points.map(([x, y]) => [x * course.scale, y * course.scale]);
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
  constructor(courseId = 'ridge') {
    this.course = COURSES[courseId] || COURSES.ridge;
    const dense = buildDensePolyline(this.course);
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

    // トンネル: 入口・出口の図の点に最も近いサンプル (i0 → i1 の順に走る)
    const nearest = ([px, py]) => {
      const wx = px * this.course.scale;
      const wy = py * this.course.scale;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < N; i++) {
        const d = Math.hypot(this.x[i] - wx, this.y[i] - wy);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    this.tunnels = (this.course.tunnels || []).map(([a, b]) => {
      const i0 = nearest(a);
      const i1 = nearest(b);
      return { i0, i1, s0: i0 * ds, s1: i1 * ds };
    });

    this.bridges = (this.course.bridges || []).map(([a, b]) => {
      const i0 = nearest(a);
      const i1 = nearest(b);
      return { i0, i1, s0: i0 * ds, s1: i1 * ds };
    });

    // ジャンプ台: 図の点に最も近い走行距離 (踏み切り位置)
    this.jumps = (this.course.jumps || []).map(([px, py]) => {
      const wx = px * this.course.scale;
      const wy = py * this.course.scale;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < N; i++) {
        const d = Math.hypot(this.x[i] - wx, this.y[i] - wy);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return { s: best * ds };
    });

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
