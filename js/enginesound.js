// 走行音 (実車のエンジン音 + タイヤのスキール + 走行ノイズ)。Web Audio で合成する。外部の音源は使わない。
// EngineModel: 速度からギア・回転数・スロットルを決める純粋な計算 (DOM / Web Audio 非依存でテストできる)
// EngineSound: Web Audio のグラフ。EngineModel の結果を受けて音にする (OfflineAudioContext でも動く)

export const GEAR_RPM_PER_KMH = [105, 66, 50, 42, 34, 27.5]; // 各ギアの「時速 1km あたりの回転数」
export const IDLE_RPM = 900;
export const REDLINE_RPM = 7400;
export const VIRTUAL_TOP_KMH = 240; // 設定の「走行速度」(最高速) を、この時速に見立てる
const UPSHIFT_RPM = 7000;
const DOWNSHIFT_RPM = 4000;
const SHIFT_LOCK = 0.4; // 変速後、次の変速まで (秒)
const CUT_TIME = 0.22; // シフトアップ中のスロットルオフ (秒)

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export class EngineModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.gear = 0; // 0 始まり (0 = 1 速)
    this.rpm = IDLE_RPM;
    this.throttle = 0.3;
    this.kmh = 0;
    this.shift = null; // 直前の更新で起きた変速: 'up' | 'down' | null
    this._lock = 0;
    this._cut = 0;
    this._blip = 0;
    this._prevSpeed = null;
    this._accel = 0;
    this._select = true; // 次の更新でギアを選び直す (起動直後・大きな速度の飛び)
  }

  // 速度に対して、回転数が 4000〜7000 に収まる最も高いギアを選ぶ
  _pick(kmh) {
    for (let g = GEAR_RPM_PER_KMH.length - 1; g >= 0; g--) {
      if (kmh * GEAR_RPM_PER_KMH[g] >= DOWNSHIFT_RPM) return g;
    }
    return 0;
  }

  // dt 秒進める。speed: 車両の速度 (mm/s)、topSpeed: 設定の走行速度 (mm/s)
  update(dt, speed, topSpeed) {
    this.shift = null;
    const kmh = clamp(speed / Math.max(1, topSpeed), 0, 1.3) * VIRTUAL_TOP_KMH;
    this.kmh = kmh;
    const ratio = () => GEAR_RPM_PER_KMH[this.gear];

    if (this._select || kmh * ratio() > 8200) {
      this.gear = this._pick(kmh);
      this._select = kmh < 20;
      this.rpm = Math.max(IDLE_RPM, kmh * ratio());
      this._blip = 0;
    }

    this._lock = Math.max(0, this._lock - dt);
    this._cut = Math.max(0, this._cut - dt);
    let target = Math.max(IDLE_RPM, kmh * ratio());
    if (this._lock <= 0) {
      if (target > UPSHIFT_RPM && this.gear < GEAR_RPM_PER_KMH.length - 1) {
        this.gear++;
        this.shift = 'up';
        this._lock = SHIFT_LOCK;
        this._cut = CUT_TIME;
      } else if (
        target < DOWNSHIFT_RPM &&
        this.gear > 0 &&
        kmh * GEAR_RPM_PER_KMH[this.gear - 1] <= 6600
      ) {
        this.gear--;
        this.shift = 'down';
        this._lock = SHIFT_LOCK;
        this._blip = 450; // ブリッピング (回転が一瞬跳ねる)
      }
      target = Math.max(IDLE_RPM, kmh * ratio());
    }

    // 回転数はなめらかに追従する。変速で目標が変わると、落ちる/跳ねる動きが音になる
    const tau = this.shift === 'down' || this._blip > 0 ? 0.04 : 0.07;
    this.rpm += (target + this._blip - this.rpm) * (1 - Math.exp(-dt / tau));
    this._blip *= Math.exp(-dt / 0.12);
    this.rpm = clamp(this.rpm, IDLE_RPM * 0.9, REDLINE_RPM + 800);

    // スロットル: 加速度から推定 (加速中は踏む、減速中は戻す)。シフトアップ中はオフ
    if (this._prevSpeed !== null && dt > 0) {
      const a = (speed - this._prevSpeed) / dt;
      this._accel += (a - this._accel) * (1 - Math.exp(-dt / 0.15));
    }
    this._prevSpeed = speed;
    const accelNorm = this._accel / Math.max(1, topSpeed * 0.5);
    this.throttle = this._cut > 0 ? 0 : clamp(0.3 + 1.1 * accelNorm, 0, 1);
    return this;
  }
}

// タイヤのスキール量 (0〜1): ドリフトが深いほど、速いほど大きい
export function squealLevel(driftAngleRad, maxDriftDeg, speed, topSpeed) {
  if (!(maxDriftDeg > 0)) return 0;
  const ratio = Math.abs(driftAngleRad) / ((maxDriftDeg * Math.PI) / 180);
  const slip = smoothstep(0.2, 0.8, ratio);
  const sp = 0.4 + 0.6 * clamp(speed / Math.max(1, topSpeed), 0, 1);
  return clamp(Math.pow(slip, 1.3) * sp, 0, 1);
}

// ---------------------------------------------------------------------------------
// Web Audio
// ---------------------------------------------------------------------------------

const CYLINDERS = 6; // 点火の基本周波数 = rpm / 60 × 気筒数 / 2

export function firingHz(rpm) {
  return (rpm / 60) * (CYLINDERS / 2);
}

function noiseBuffer(ctx, seconds = 2, seed = 1) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let a = seed | 0;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    d[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return buf;
}

function softClipCurve(drive) {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return c;
}

export class EngineSound {
  // ctx: AudioContext か OfflineAudioContext
  constructor(ctx, destination) {
    this.ctx = ctx;
    const out = destination || ctx.destination;

    // 全体 → コンプレッサー (音割れ防止) → 出力
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    this.master.connect(comp);
    comp.connect(out);

    // ---- エンジン: 3 つの発振器 (点火の基本 + 半次の唸り + 2 倍音) → 歪み → ローパス → 排気の共鳴 ----
    this.o1 = ctx.createOscillator();
    this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator();
    this.o2.type = 'square';
    this.o3 = ctx.createOscillator();
    this.o3.type = 'sawtooth';
    const g1 = ctx.createGain();
    g1.gain.value = 0.55;
    const g2 = ctx.createGain();
    g2.gain.value = 0.16;
    const g3 = ctx.createGain();
    g3.gain.value = 0.14;
    const mix = ctx.createGain();
    this.o1.connect(g1).connect(mix);
    this.o2.connect(g2).connect(mix);
    this.o3.connect(g3).connect(mix);
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(2.4);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.9;
    this.res = ctx.createBiquadFilter();
    this.res.type = 'peaking';
    this.res.frequency.value = 230;
    this.res.gain.value = 6;
    this.res.Q.value = 1.1;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    mix.connect(shaper);
    shaper.connect(this.lp);
    this.lp.connect(this.res);
    this.res.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // ---- 吸気・機械音 (回転とスロットルで大きくなる帯域ノイズ) ----
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 2, 5);
    noise.loop = true;
    this.intakeBp = ctx.createBiquadFilter();
    this.intakeBp.type = 'bandpass';
    this.intakeBp.Q.value = 0.8;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    noise.connect(this.intakeBp).connect(this.intakeGain).connect(this.master);

    // ---- タイヤのスキール: 帯域ノイズ + 揺れる発振器 ----
    const noise2 = ctx.createBufferSource();
    noise2.buffer = noiseBuffer(ctx, 2, 9);
    noise2.loop = true;
    this.squealBp = ctx.createBiquadFilter();
    this.squealBp.type = 'bandpass';
    this.squealBp.Q.value = 7;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    noise2.connect(this.squealBp).connect(this.squealGain).connect(this.master);
    this.sqOsc = ctx.createOscillator();
    this.sqOsc.type = 'triangle';
    this.sqOscGain = ctx.createGain();
    this.sqOscGain.gain.value = 0;
    this.sqOsc.connect(this.sqOscGain).connect(this.master);
    // 音程の揺れ (ビブラート)
    this.vib = ctx.createOscillator();
    this.vib.frequency.value = 11;
    this.vibDepth = ctx.createGain();
    this.vibDepth.gain.value = 25;
    this.vib.connect(this.vibDepth).connect(this.sqOsc.frequency);

    // ---- 走行ノイズ (路面と風): ローパスをかけたノイズ ----
    const noise3 = ctx.createBufferSource();
    noise3.buffer = noiseBuffer(ctx, 2, 13);
    noise3.loop = true;
    this.roadLp = ctx.createBiquadFilter();
    this.roadLp.type = 'lowpass';
    this.roadLp.frequency.value = 600;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    noise3.connect(this.roadLp).connect(this.roadGain).connect(this.master);

    for (const s of [this.o1, this.o2, this.o3, noise, noise2, this.sqOsc, this.vib, noise3]) s.start();
    this._jitterAt = 0;
    this._jitter = 1;
    this._muted = true;
  }

  setMuted(muted) {
    this._muted = muted;
    if (muted) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  // p: { rpm, throttle, squeal (0〜1), speedNorm (0〜1)、volume (0〜1)、tire (0〜2) }。t: 反映する時刻
  update(p, t = this.ctx.currentTime) {
    const tc = 0.03;
    const f = firingHz(p.rpm);
    // 回転のわずかなゆらぎ (一定すぎると電子音っぽくなる)
    if (t - this._jitterAt > 0.05) {
      this._jitterAt = t;
      this._jitter = 1 + (Math.sin(t * 37.1) * 0.004 + Math.sin(t * 91.7) * 0.003);
    }
    const ff = f * this._jitter;
    this.o1.frequency.setTargetAtTime(ff, t, tc);
    this.o2.frequency.setTargetAtTime(ff * 0.5, t, tc);
    this.o3.frequency.setTargetAtTime(ff * 2.004, t, tc);

    const load = p.throttle;
    // 音色: 回転とスロットルで明るくなる。スロットルを戻すとこもる
    this.lp.frequency.setTargetAtTime(500 + p.rpm * 0.55 + load * 1700, t, tc);
    const rpmN = clamp((p.rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM), 0, 1);
    this.engineGain.gain.setTargetAtTime(0.32 + 0.5 * load + 0.2 * rpmN, t, tc);

    this.intakeBp.frequency.setTargetAtTime(900 + p.rpm * 0.35, t, tc);
    this.intakeGain.gain.setTargetAtTime(0.02 + 0.12 * load * rpmN, t, tc);

    // タイヤ
    const sq = clamp(p.squeal, 0, 1) * clamp(p.tire, 0, 2);
    const sqHz = 850 + p.speedNorm * 700 + clamp(p.squeal, 0, 1) * 350;
    this.squealBp.frequency.setTargetAtTime(sqHz * 1.3, t, tc);
    this.squealGain.gain.setTargetAtTime(sq * 1.1, t, tc);
    this.sqOsc.frequency.setTargetAtTime(sqHz, t, tc);
    this.sqOscGain.gain.setTargetAtTime(sq * 0.3, t, tc);

    // 走行ノイズ
    this.roadLp.frequency.setTargetAtTime(350 + p.speedNorm * 900, t, tc);
    this.roadGain.gain.setTargetAtTime(0.01 + 0.09 * p.speedNorm * p.speedNorm, t, tc);

    // 全体の音量 (0〜1 を二乗して、小さい値でも細かく調整できるようにする)
    const vol = clamp(p.volume, 0, 1);
    this.master.gain.setTargetAtTime(this._muted ? 0 : 0.55 * vol * vol, t, 0.08);
  }

  dispose() {
    for (const s of [this.o1, this.o2, this.o3, this.sqOsc, this.vib]) {
      try {
        s.stop();
      } catch {
        /* 既に停止 */
      }
    }
    try {
      this.master.disconnect();
    } catch {
      /* 既に切断 */
    }
  }
}
