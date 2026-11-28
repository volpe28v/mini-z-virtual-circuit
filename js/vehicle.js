// 仮想車両。位置・速度・車体の向き・進行方向・ドリフト角を管理する (DOM 非依存)。
// heading = travelDirection + driftAngle。進行方向と車体の向きは独立に持つ。

const DEG = Math.PI / 180;
const FIXED_STEP = 1 / 120;
const LOOKAHEAD_S = 0.16; // ドリフト開始を先読みする時間
const K_LOW = 1 / 1200; // これより緩いコーナーではドリフトしない
const K_HIGH = 1 / 250; // これより急なコーナーでは最大角
const CARRY_TAU = 0.45; // 引きずりでグリップが戻る時間定数 (秒。設定 1 のとき)
const FEINT_LOOK_S = 0.8; // フェイントのためにコーナーを先読みする時間
const JUMP_TIME = 0.7; // 滞空時間 (秒)
const FEINT_ANGLE = 0.7; // フェイントの振り出し角 (最大ドリフト角に対する比。設定 1 のとき)

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 位置 s (走行距離) のなめらかな乱数 (-1〜1)。格子点ごとの値をコサインで補間する。同じ s なら同じ値 (再現できる)
function hash01(i) {
  let t = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  t ^= t >>> 13;
  t = Math.imul(t, 0xc2b2ae35);
  t ^= t >>> 16;
  return (t >>> 0) / 4294967296;
}
function smoothNoise(s, wavelength, seed) {
  const x = s / wavelength;
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(i * 7919 + seed) * 2 - 1;
  const b = hash01((i + 1) * 7919 + seed) * 2 - 1;
  const t = (1 - Math.cos(Math.PI * f)) / 2;
  return a + (b - a) * t;
}
// 走行ラインのふらつき: 長い波と短い波を重ねる。走行距離で決めるので、周ごとに違うラインになる
export function wanderAt(s) {
  return (smoothNoise(s, 800, 11) + 0.45 * smoothNoise(s, 320, 53)) / 1.45;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 周ごとの変化は、黄金比に基づく数列で決める (乱数と違い、どの周も確実に散らばり、再現できる)
function frac(x) {
  return x - Math.floor(x);
}

export class Vehicle {
  constructor(track) {
    this.track = track;
    this.driftScale = 1; // ドリフト角の倍率 (周ごとの変化やラバーラインの基準走行で使う)
    this.offsetBias = 0; // 横位置のずれ (mm)
    this.lapVariation = false; // true なら、周回ごとにドリフト角 (±10%) と横位置 (±7mm) をわずかに変える
    this._lap = -1;
    this._hold = 0; // 引きずり込みの目標角 (rad)
    this._feintW = 0; // いまのフェイントの強さ 0〜1 (テスト・表示用)
    this._feintDir = 0;
    this.pos = { x: 0, y: 0 };
    this._c = {};
    // ドリフトの出始め・最大角になる曲率 (コースごとに変えられる。大きな半径のトラックは、緩いコーナーでも最大角まで振る)
    const dk = (track.course && track.course.driftK) || {};
    this.kLow = dk.low ?? K_LOW;
    this.kHigh = dk.high ?? K_HIGH;
    this.driftGain = dk.gain ?? 1; // 最大角への倍率 (広い面のトラックは、大きな角度で滑り続ける)
    this.slideGain = dk.slide ?? 1; // コーナーの外へ膨らむ量への倍率
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
    this._hold = 0;
    this._lap = -1;
    this.air = 0; // 浮き具合 0〜1 (0 = 接地)
    this._airT = -1; // 滞空の経過時間 (秒)。負なら接地
    this.landT = 99; // 着地してからの時間 (秒)
    this.landKick = 0; // 着地の衝撃 (着地した 1 ステップだけ 1)
    this.landings = 0; // 着地した回数 (描画・煙が数えて、着地を取りこぼさない)
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
    if (this.lapVariation) {
      // 周回が変わるたびに少しだけ変える (同じ軌跡の完全な繰り返しにならない。タイヤ痕が周ごとにずれる)
      const lap = Math.floor(this.progress / tr.length);
      if (lap !== this._lap) {
        this._lap = lap;
        this.driftScale = 0.9 + 0.2 * frac(lap * 0.754877666 + 0.3);
        this.offsetBias = (frac(lap * 0.618033988 + 0.1) - 0.5) * 14;
      }
    }
    const u = tr.speedAt(this.progress);
    const vTarget = st.speed * u;
    if (this._first) {
      this.speed = vTarget;
      this._first = false;
    }
    this.speed += (vTarget - this.speed) * (1 - Math.exp(-dt / 0.1));

    const kLook = tr.kappaAt(this.progress + this.speed * LOOKAHEAD_S);
    const k0 = tr.kappaAt(this.progress);
    const gLook = smoothstep(this.kLow, this.kHigh, Math.abs(kLook));
    const g0 = smoothstep(this.kLow, this.kHigh, Math.abs(k0));

    const strength = st.driftStrength;
    const maxD = st.maxDrift * DEG * this.driftGain;
    // ウェット路面はグリップが低く、角度が深く、長く滑る
    const wet = Math.min(1, Math.max(0, st.wet ?? 0));
    const amp = Math.min(1, strength) * (0.65 + 0.35 * u) * (1 + 0.15 * wet);
    let target = Math.sign(kLook) * gLook * maxD * amp * this.driftScale;

    // 引きずり: コーナーを抜けても角度は急には戻らず、直線に入ってもしばらく滑り続けて、ゆっくりグリップが戻る。
    // 逆向きの新しいコーナーが来たら (2° 超) すぐ追従する
    const carry = Math.min(2, Math.max(0, st.carry ?? 0));
    if (carry > 0) {
      const flip = target * this._hold < 0 && Math.abs(target) > 2 * DEG;
      if (flip || Math.abs(target) >= Math.abs(this._hold)) {
        this._hold = target;
      } else {
        const tau = CARRY_TAU * carry * (1 + 0.8 * wet);
        this._hold += (target - this._hold) * (1 - Math.exp(-dt / tau));
      }
      target = this._hold;
    } else {
      this._hold = target;
    }

    // フェイント (D1 のフリック): 直線の終わりで、先にコーナーと逆へ車体を振り、反動でコーナーへ切り込む。
    // 遠くのコーナーが急で、手前 (いま・先読み位置) がまだ直線のときだけ働く
    const feint = Math.min(2, Math.max(0, st.feint ?? 0));
    let fw = 0;
    if (feint > 0) {
      const kFar = tr.kappaAt(this.progress + this.speed * FEINT_LOOK_S);
      const gFar = smoothstep(this.kLow, this.kHigh, Math.abs(kFar));
      fw = gFar * (1 - Math.min(1, gLook * 2)) * (1 - g0);
      target -= Math.sign(kFar) * fw * maxD * FEINT_ANGLE * feint * Math.min(1, strength + 0.3) * this.driftScale;
      this._feintDir = Math.sign(kFar);
    }
    this._feintW = fw;

    // ドリフト角: 2 次ばね。強度が大きいほどキビキビ + 軽いオーバーシュート
    const sN = Math.min(2, Math.max(0, strength)) / 2;
    const omega = lerp(4, 9, sN) + 5 * fw; // フェイント中は素早く振る
    const zeta = lerp(0.85, 0.5, sN);
    // 空中はタイヤが路面に触れないので、グリップが効かない (角度をそのまま保つ)
    const grip = this._airT >= 0 ? 0 : 1;
    const acc = grip * (omega * omega * (target - this.driftAngle) - 2 * zeta * omega * this.driftRate);
    this.driftRate += acc * dt;
    if (grip === 0) this.driftRate *= Math.exp(-dt / 0.12); // 空中は角度をほぼそのまま保つ
    // 角速度の上限 (強度に応じて 50〜150°/s)。急な角度変化を避ける
    const rateLim = (100 * (0.5 + 0.5 * Math.min(2, strength)) * DEG);
    this.driftRate = Math.min(rateLim, Math.max(-rateLim, this.driftRate));
    this.driftAngle += this.driftRate * dt;
    const lim = maxD * 1.12 * Math.max(this.driftScale, 1) * (1 + 0.15 * wet);
    this.driftAngle = Math.min(lim, Math.max(-lim, this.driftAngle));

    // 横オフセット: ドリフト中にコーナーの外側へ膨らむ
    // ライン取りのふらつき: 道幅の中で左右にゆるやかに動く。コーナーの中では控えめ (ドリフトの外への膨らみが主役)
    const wander = Math.min(2, Math.max(0, st.wander ?? 0));
    const wTarget = wander * 0.3 * st.trackWidth * wanderAt(this.progress) * (1 - 0.6 * g0);
    let oTarget =
      -Math.sign(this._hold) * Math.min(1, Math.abs(this._hold) / Math.max(1e-6, maxD * 0.8)) * 0.14 * this.slideGain * st.trackWidth * Math.min(1, strength) +
      // フェイント中は、車体を振った側 (コーナーの外側) へ少し寄る
      -(this._feintDir || 0) * this._feintW * 0.06 * st.trackWidth * Math.min(1, feint) +
      this.offsetBias +
      wTarget;
    const oLim = 0.36 * (1 + Math.max(0, this.slideGain - 1) * 0.5) * st.trackWidth; // 車体が道幅から大きくはみ出さないよう、目標を丸める
    oTarget = Math.min(oLim, Math.max(-oLim, oTarget));
    const oOmega = 2.5;
    const oAcc = oOmega * oOmega * (oTarget - this.offset) - 2 * oOmega * this.offsetRate;
    this.offsetRate += oAcc * dt;
    this.offset += this.offsetRate * dt;

    const before = this.progress;
    this.progress += this.speed * dt;
    this._jump(before, dt, st, kLook);
    this._compose();
  }

  // ジャンプ台の踏み切りを通ったら飛び、一定時間で着地する。着地では車体がわずかに振られる
  _jump(before, dt, st, kLook) {
    const L = this.track.length;
    this.landT += dt;
    this.landKick = 0;
    const amp = Math.min(1.5, Math.max(0, st.jump ?? 0));
    if (this._airT >= 0) {
      this._airT += dt;
      if (this._airT >= JUMP_TIME) {
        this._airT = -1;
        this.air = 0;
        this.landT = 0;
        this.landKick = 1;
        this.landings++;
        // 着地の衝撃: 車体が少し振られる (次のコーナーの向きへ)
        this.driftRate += (Math.sign(kLook) || 1) * 40 * DEG * Math.min(1, amp);
      } else {
        this.air = Math.sin((Math.PI * this._airT) / JUMP_TIME);
      }
      return;
    }
    if (!(amp > 0) || this.speed < 80) return;
    for (const j of this.track.jumps) {
      if (Math.floor((before - j.s) / L) !== Math.floor((this.progress - j.s) / L)) {
        this._airT = 0;
        this.air = 0;
        break;
      }
    }
  }

  // dt 秒進める (内部は固定ステップ)。onStep を渡すと、ステップごとに呼ぶ (タイヤ痕の記録用)
  update(dt, st, onStep) {
    let left = dt;
    while (left > 1e-9) {
      const h = Math.min(FIXED_STEP, left);
      this._step(h, st);
      if (onStep) onStep(this);
      left -= h;
    }
  }
}
