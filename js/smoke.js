// タイヤスモーク。ドリフト中に後輪の位置から煙の粒を出す (DOM 非依存)。
// 粒はワールド座標に固定され、車が進むと路面の上に尾を引いて残る。リングバッファで固定長 (毎フレームの確保なし)。
import { carGeometry } from './camera.js';

export const MAX_PARTICLES = 450;
export const MAX_SPARKS = 64; // 着地の火花の上限
export const MAX_AMOUNT = 3; // 設定「タイヤスモーク」の上限
const MAX_ALPHA = 0.85; // 1 粒の不透明度の上限 (重なりで濃くなる)
const DEG = 180 / Math.PI;
const CARRY = 0.75; // 発生時に車の速度のうちどれだけを引き継ぐか
const DRAG = 1.2; // 空気抵抗 (1/s)

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export class SmokeSystem {
  constructor(seed = 7) {
    const n = MAX_PARTICLES;
    this.cap = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n); // 0 = 未使用
    this.r0 = new Float32Array(n); // 半径 (mm) の初期値と最終値
    this.r1 = new Float32Array(n);
    this.a0 = new Float32Array(n); // 不透明度の最大値
    this.head = 0;
    // 火花 (着地で後輪から散る。短命で、ワールドに固定)
    this.sx = new Float32Array(MAX_SPARKS);
    this.sy = new Float32Array(MAX_SPARKS);
    this.svx = new Float32Array(MAX_SPARKS);
    this.svy = new Float32Array(MAX_SPARKS);
    this.sage = new Float32Array(MAX_SPARKS);
    this.slife = new Float32Array(MAX_SPARKS); // 0 = 未使用
    this.shead = 0;
    this.acc = [0, 0]; // 左右の後輪の発生タイマー
    this.driftTime = 0; // ドリフトが続いている時間 (秒)。コーナーの間のわずかな中断では急に 0 に戻らない
    this.flow = [1, 1]; // 左右の後輪ごとの出方のむら (平均 1)
    this.flowTarget = [1, 1];
    this.flowTimer = 0;
    this.wet = 0;
    this.puff = 0; // 一気に濃く出るふかし (0〜1)
    this.rng = mulberry32(seed);
  }

  reset() {
    this.life.fill(0);
    this.slife.fill(0);
    this.acc[0] = this.acc[1] = 0;
    this.driftTime = 0;
    this.puff = 0;
    this._landings = null;
  }

  alive(i) {
    return this.life[i] > 0;
  }

  get sparkCount() {
    let n = 0;
    for (let i = 0; i < MAX_SPARKS; i++) if (this.slife[i] > 0) n++;
    return n;
  }

  get count() {
    let n = 0;
    for (let i = 0; i < this.cap; i++) if (this.life[i] > 0) n++;
    return n;
  }

  // 粒を進める + 新しい粒を出す。veh は Vehicle (position, heading, driftAngle, speed, velocity)、st は設定。
  update(dt, veh, st) {
    // 火花
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.slife[i] <= 0) continue;
      this.sage[i] += dt;
      if (this.sage[i] >= this.slife[i]) {
        this.slife[i] = 0;
        continue;
      }
      this.sx[i] += this.svx[i] * dt;
      this.sy[i] += this.svy[i] * dt;
      const drag = Math.exp(-3.5 * dt);
      this.svx[i] *= drag;
      this.svy[i] *= drag;
    }
    // 既存の粒
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        continue;
      }
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      // 空気抵抗で徐々に止まる
      const drag = Math.exp(-DRAG * dt);
      this.vx[i] *= drag;
      this.vy[i] *= drag;
    }

    const amount = st.smoke;
    this.wet = st.wet ?? 0;
    if (this._landings == null) this._landings = veh.landings || 0;
    const landings = veh.landings || 0;
    if (landings !== this._landings) {
      this._landings = landings;
      this._sparks(veh, st);
      if (amount > 0) this._landing(veh, st, amount);
    }
    if (veh.air > 0) {
      this.acc[0] = this.acc[1] = 0; // 空中は煙が出ない
      return;
    }
    if (!(amount > 0) || !(st.maxDrift > 0)) {
      this.acc[0] = this.acc[1] = 0;
      this.driftTime = 0;
      return;
    }
    // 角度がしきい値 (既定 15°、最大角が小さいときはその半分) を超えたら出す
    const beta = Math.abs(veh.driftAngle) * DEG;
    const thr = Math.min(15, st.maxDrift * 0.5);
    if (beta < thr) {
      this.acc[0] = this.acc[1] = 0;
      this.driftTime *= Math.exp(-dt / 0.5); // 抜けたら余韻なく戻る (すぐ次のコーナーなら少し持ち越す)
      return;
    }
    this.driftTime += dt;
    this._wobble(dt);
    // 強さ 0〜1: ドリフトが深いほど、速いほど強い
    const depth = clamp((beta - thr) / Math.max(1, st.maxDrift - thr), 0, 1);
    const speedF = 0.6 + 0.4 * clamp(veh.speed / Math.max(1, st.speed * 0.6), 0, 1);
    const i = depth * speedF;
    // ドリフトが長く続くほどタイヤが温まって煙が増える (0.65 倍 → 約 1.6 倍。1.5 秒で頭打ち)
    const durF = 0.65 + 0.95 * smoothstep(0, 1.5, this.driftTime);
    this.durF = durF;
    const base = Math.min(MAX_AMOUNT, amount) * (10 + 30 * i) * durF; // 1 輪あたりの粒数/秒

    const g = carGeometry(st.carLength, st.carWidth);
    const h = veh.heading;
    const fx = Math.cos(h);
    const fy = Math.sin(h);
    const rx = -fy;
    const ry = fx;
    for (let w = 0; w < 2; w++) {
      const side = w === 0 ? -1 : 1;
      // 出方のむら + ときどきのふかし (どちらも平均はほぼ 1 倍)
      this.acc[w] += base * this.flow[w] * (1 + 1.6 * this.puff) * dt;
      while (this.acc[w] >= 1) {
        this.acc[w] -= 1;
        this._spawn(veh, side, fx, fy, rx, ry, g, i, amount, dt);
      }
    }
  }

  // 着地の火花: 左右の後輪から、車体の外側・後ろへ勢いよく散る (煙の設定とは別。ジャンプ 0 なら出ない = 着地が起きない)
  _sparks(veh, st) {
    const g = carGeometry(st.carLength, st.carWidth);
    const fx = Math.cos(veh.heading);
    const fy = Math.sin(veh.heading);
    const rx = -fy;
    const ry = fx;
    const rnd = this.rng;
    const n = 12;
    for (let w = 0; w < 2; w++) {
      const side = w === 0 ? -1 : 1;
      for (let k = 0; k < n; k++) {
        const i = this.shead;
        this.shead = (this.shead + 1) % MAX_SPARKS;
        this.sx[i] = veh.position.x - fx * (g.wheelbase / 2) + rx * side * (g.track / 2) + (rnd() - 0.5) * 6;
        this.sy[i] = veh.position.y - fy * (g.wheelbase / 2) + ry * side * (g.track / 2) + (rnd() - 0.5) * 6;
        // 向き: 車体の外側 (横) と後ろに広がる。速さはばらつく
        const sp = 160 + rnd() * 380;
        const ang = (rnd() - 0.5) * 2.2; // 横向きを中心に ±63°
        const lat = Math.cos(ang) * side;
        const back = Math.sin(ang) - 0.5;
        this.svx[i] = veh.velocity.x * 0.6 + (rx * lat + fx * back) * sp;
        this.svy[i] = veh.velocity.y * 0.6 + (ry * lat + fy * back) * sp;
        this.sage[i] = 0;
        this.slife[i] = 0.22 + rnd() * 0.3;
      }
    }
  }

  // 着地: 左右の後輪から、ドリフトの有無によらず土煙を一気に出す
  _landing(veh, st, amount) {
    const g = carGeometry(st.carLength, st.carWidth);
    const fx = Math.cos(veh.heading);
    const fy = Math.sin(veh.heading);
    const rx = -fy;
    const ry = fx;
    const n = Math.round(7 * Math.min(2, amount));
    for (let w = 0; w < 2; w++) {
      for (let k = 0; k < n; k++) this._spawn(veh, w === 0 ? -1 : 1, fx, fy, rx, ry, g, 0.9, amount, 1 / 60);
    }
    this.puff = 1;
  }

  // 出方のむらを、時間で進める。0.08〜0.25 秒ごとに目標を引き直してなめらかに追う (フレームレートによらない)
  _wobble(dt) {
    const rnd = this.rng;
    this.flowTimer -= dt;
    while (this.flowTimer <= 0) {
      this.flowTimer += 0.08 + rnd() * 0.17;
      this.flowTarget[0] = 0.4 + 1.2 * rnd();
      this.flowTarget[1] = 0.4 + 1.2 * rnd();
      if (rnd() < 0.18) this.puff = 1; // ふかし
    }
    const f = 1 - Math.exp(-dt / 0.07);
    this.flow[0] += (this.flowTarget[0] - this.flow[0]) * f;
    this.flow[1] += (this.flowTarget[1] - this.flow[1]) * f;
    this.puff *= Math.exp(-dt / 0.12);
  }

  _spawn(veh, side, fx, fy, rx, ry, g, i, amount, dt) {
    const k = this.head;
    this.head = (this.head + 1) % this.cap;
    const rnd = this.rng;
    // フレーム内で出た時刻をばらして、粒が等間隔の点にならないようにする
    const back = rnd() * dt;
    const wx = veh.position.x - veh.velocity.x * back - fx * (g.wheelbase / 2) + rx * side * (g.track / 2);
    const wy = veh.position.y - veh.velocity.y * back - fy * (g.wheelbase / 2) + ry * side * (g.track / 2);
    this.x[k] = wx + (rnd() - 0.5) * 4;
    this.y[k] = wy + (rnd() - 0.5) * 4;
    // 煙は空気に乗って車と一緒にしばらく進み (画面の外へ一瞬で流れ去らない)、車体の外側へ広がる
    const out = (40 + rnd() * 50) * (0.7 + 0.6 * i);
    this.vx[k] = veh.velocity.x * CARRY + rx * side * out + (rnd() - 0.5) * 14;
    this.vy[k] = veh.velocity.y * CARRY + ry * side * out + (rnd() - 0.5) * 14;
    this.age[k] = 0;
    const wet = Math.min(1, Math.max(0, this.wet || 0)); // 雨: 煙より低く速く広がる水煙。短命
    this.life[k] = (0.9 + rnd() * 0.9 + 0.3 * i) * (0.85 + 0.15 * (this.durF || 1)) * (1 - 0.4 * wet);
    this.r0[k] = 5 + rnd() * 3;
    this.r1[k] = (17 + rnd() * 14 + 10 * i) * (0.9 + 0.2 * (this.durF || 1)) * (1 + 0.3 * wet);
    this.a0[k] = Math.min(MAX_ALPHA, (0.3 + 0.3 * i) * (0.8 + 0.4 * rnd()) * Math.min(MAX_AMOUNT, amount) * (1 - 0.2 * wet));
  }
}

// 粒の半径 (mm): ふわっと広がる (最初に速く、あとはゆっくり)
export function smokeSize(s, i) {
  const t = s.age[i] / s.life[i];
  const e = 1 - (1 - t) * (1 - t);
  return s.r0[i] + (s.r1[i] - s.r0[i]) * e;
}

// 粒の不透明度: すぐに立ち上がり、徐々に消える
export function smokeAlpha(s, i) {
  const t = s.age[i] / s.life[i];
  return s.a0[i] * Math.min(1, t * 8) * Math.pow(1 - t, 1.5);
}
