// 仮想車両。位置・速度・車体の向き・進行方向・ドリフト角を管理する (DOM 非依存)。
// heading = travelDirection + driftAngle。進行方向と車体の向きは独立に持つ。

const DEG = Math.PI / 180;
const FIXED_STEP = 1 / 120;
const LOOKAHEAD_S = 0.16; // ドリフト開始を先読みする時間
const K_LOW = 1 / 1200; // これより緩いコーナーではドリフトしない
const K_HIGH = 1 / 250; // これより急なコーナーでは最大角

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export class Vehicle {
  constructor(track) {
    this.track = track;
    this.driftScale = 1; // タイヤ痕の基準走行で周ごとに変える
    this.offsetBias = 0;
    this.pos = { x: 0, y: 0 };
    this._c = {};
    this.reset();
  }

  reset(s0 = this.track.startS) {
    this.progress = s0; // コース上の走行距離 (mm、周回しても戻らない)
    this.speed = 0;
    this.driftAngle = 0;
    this.driftRate = 0;
    this.offset = 0;
    this.offsetRate = 0;
    this.velocity = { x: 0, y: 0 };
    this.heading = 0;
    this.travelDirection = 0;
    this.speed = 0;
    this._first = true;
    this._compose(0);
  }

  get position() {
    return this.pos;
  }

  // 位置・速度・向きを現在の状態から組み立てる
  _compose() {
    const c = this.track.at(this.progress, this._c);
    const cos = Math.cos(c.theta);
    const sin = Math.sin(c.theta);
    const nx = -sin;
    const ny = cos;
    this.pos.x = c.x + nx * this.offset;
    this.pos.y = c.y + ny * this.offset;
    const along = this.speed * (1 - c.kappa * this.offset);
    this.velocity.x = cos * along + nx * this.offsetRate;
    this.velocity.y = sin * along + ny * this.offsetRate;
    this.travelDirection = Math.atan2(this.velocity.y, this.velocity.x);
    // 停止中は速度ベクトルが 0 になるので接線方向を使う
    if (along === 0 && this.offsetRate === 0) this.travelDirection = c.theta;
    this.heading = this.travelDirection + this.driftAngle;
  }

  _step(dt, st) {
    const tr = this.track;
    const u = tr.speedAt(this.progress);
    const vTarget = st.speed * u;
    if (this._first) {
      this.speed = vTarget;
      this._first = false;
    }
    this.speed += (vTarget - this.speed) * (1 - Math.exp(-dt / 0.1));

    const kLook = tr.kappaAt(this.progress + this.speed * LOOKAHEAD_S);
    const k0 = tr.kappaAt(this.progress);
    const gLook = smoothstep(K_LOW, K_HIGH, Math.abs(kLook));
    const g0 = smoothstep(K_LOW, K_HIGH, Math.abs(k0));

    const strength = st.driftStrength;
    const maxD = st.maxDrift * DEG;
    const amp = Math.min(1, strength) * (0.65 + 0.35 * u);
    const target = Math.sign(kLook) * gLook * maxD * amp * this.driftScale;

    // ドリフト角: 2 次ばね。強度が大きいほどキビキビ + 軽いオーバーシュート
    const sN = Math.min(2, Math.max(0, strength)) / 2;
    const omega = lerp(4, 9, sN);
    const zeta = lerp(0.85, 0.5, sN);
    const acc = omega * omega * (target - this.driftAngle) - 2 * zeta * omega * this.driftRate;
    this.driftRate += acc * dt;
    // 角速度の上限 (強度に応じて 50〜150°/s)。急な角度変化を避ける
    const rateLim = (100 * (0.5 + 0.5 * Math.min(2, strength)) * DEG);
    this.driftRate = Math.min(rateLim, Math.max(-rateLim, this.driftRate));
    this.driftAngle += this.driftRate * dt;
    const lim = maxD * 1.12 * Math.max(this.driftScale, 1);
    this.driftAngle = Math.min(lim, Math.max(-lim, this.driftAngle));

    // 横オフセット: ドリフト中にコーナーの外側へ膨らむ
    const oTarget =
      -Math.sign(k0) * g0 * 0.14 * st.trackWidth * Math.min(1, strength) + this.offsetBias;
    const oOmega = 2.5;
    const oAcc = oOmega * oOmega * (oTarget - this.offset) - 2 * oOmega * this.offsetRate;
    this.offsetRate += oAcc * dt;
    this.offset += this.offsetRate * dt;

    this.progress += this.speed * dt;
    this._compose();
  }

  // dt 秒進める (内部は固定ステップ)
  update(dt, st) {
    let left = dt;
    while (left > 1e-9) {
      const h = Math.min(FIXED_STEP, left);
      this._step(h, st);
      left -= h;
    }
  }
}
