// コース形状。ワールド座標は mm、y は下向き、角度は atan2(y, x) 基準 (東 = 0、時計回りが正)。
// 左コーナーは角度が減る = 曲率 κ < 0。法線 N = (-sin θ, cos θ) は κ > 0 のとき曲がる中心側を向く。

export const SAMPLE_STEP = 4; // 再サンプル間隔 (mm)
const DENSE_STEP = 2; // 折れ線生成の間隔 (mm)
const SMOOTH_SIGMA = 30; // 位置の平滑化 (mm)
const KAPPA_SIGMA = 25; // 曲率の平滑化 (mm)
const KAPPA0 = 1 / 900; // この曲率より緩ければ全速
const U_MIN = 0.3;
const BRAKE = 0.0008; // u² の減少率 / mm
const ACCEL = 0.00065;

const DEG = Math.PI / 180;

export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// ---- ターン形式で折れ線を作る ----
function buildDensePolyline() {
  const pts = [];
  let x = -1000;
  let y = 1000;
  let th = 0;
  pts.push([x, y]);

  const line = (len) => {
    const n = Math.max(1, Math.round(len / DENSE_STEP));
    const d = len / n;
    for (let i = 0; i < n; i++) {
      x += Math.cos(th) * d;
      y += Math.sin(th) * d;
      pts.push([x, y]);
    }
  };
  // dir: -1 = 左、+1 = 右
  const arc = (r, deg, dir) => {
    const total = deg * DEG;
    const n = Math.max(2, Math.round((r * total) / DENSE_STEP));
    const dth = (dir * total) / n;
    const chord = 2 * r * Math.sin(Math.abs(dth) / 2);
    for (let i = 0; i < n; i++) {
      x += Math.cos(th + dth / 2) * chord;
      y += Math.sin(th + dth / 2) * chord;
      th += dth;
      pts.push([x, y]);
    }
  };

  line(1900); // メインストレート
  arc(500, 90, -1); // 右側のスイーパー (左)
  line(650);
  arc(190, 180, -1); // ヘアピン (左)
  line(250);
  arc(300, 90, +1); // 右コーナー
  line(220);
  arc(260, 38, -1); // シケイン
  arc(260, 76, +1);
  arc(260, 38, -1);
  // 閉ループにするための戻り直線と U ターン (西向き)
  const lWest = x - -1000;
  line(lWest);
  const rU = (1000 - y) / 2;
  arc(rU, 180, -1);
  // 終点 = 始点 (-1000, 1000)
  pts.pop();
  return pts;
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

    // S/F ライン: 最初の直線の x = 0 の位置
    this.finishS = 1000;
    this.startS = this.finishS - 120; // 少し手前から始める
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
