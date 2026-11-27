// 天候の自動変化 (DOM 非依存)。晴れ → 小雨 → 土砂降り → 晴れ を、時間でゆるやかに切り替える。
// 降り方 (rain) は段階の目標へなめらかに変わり、路面の濡れ具合 (wet) は、降り始めは速く、やんだあとはゆっくり乾く。

// 段階: 雨の強さの範囲と、続く時間 (秒) の範囲。次の段階は確率で選ぶ (晴れ → 小雨 → 土砂降り → 晴れ が基本)
const PHASES = {
  clear: { name: '晴れ', rain: [0, 0], hold: [45, 90], next: [['drizzle', 1]] },
  drizzle: { name: '小雨', rain: [0.3, 0.5], hold: [25, 50], next: [['heavy', 0.6], ['clear', 0.4]] },
  heavy: { name: '土砂降り', rain: [0.8, 1], hold: [20, 45], next: [['drizzle', 0.35], ['clear', 0.65]] },
};
const FADE = [10, 18]; // 段階が切り替わるときの、雨の強さが変わる時間 (秒)
const TAU_WET = 6; // 路面が濡れる時定数 (秒)
const TAU_DRY = 22; // 乾く時定数 (秒)

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smooth(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export class Weather {
  constructor(seed = 20261127, start = 'clear') {
    this.rng = mulberry32(seed);
    this.phase = start;
    this.rain = 0; // いまの降り方 0〜1 (波紋・雨粒の強さ)
    this.wet = 0; // 路面の濡れ具合 0〜1 (見た目とグリップ)
    this.from = 0;
    this.to = 0;
    this.fade = 0; // 切り替えの経過 (秒)
    this.fadeLen = 1;
    this.holdLeft = this._range(PHASES[start].hold);
  }

  _range([a, b]) {
    return a + (b - a) * this.rng();
  }

  get label() {
    return PHASES[this.phase].name;
  }

  // 目標の降り方に近づき、その後 hold の間とどまり、次の段階を選ぶ
  update(dt) {
    if (this.fade < this.fadeLen) {
      this.fade += dt;
      this.rain = this.from + (this.to - this.from) * smooth(this.fade / this.fadeLen);
    } else {
      this.holdLeft -= dt;
      if (this.holdLeft <= 0) this._advance();
    }
    // 濡れ具合: 雨に追いつくのは速く、乾くのはゆっくり
    const tau = this.rain > this.wet ? TAU_WET : TAU_DRY;
    this.wet += (this.rain - this.wet) * (1 - Math.exp(-dt / tau));
  }

  _advance() {
    const opts = PHASES[this.phase].next;
    let r = this.rng();
    let pick = opts[opts.length - 1][0];
    for (const [name, p] of opts) {
      if (r < p) {
        pick = name;
        break;
      }
      r -= p;
    }
    this.phase = pick;
    const ph = PHASES[pick];
    this.from = this.rain;
    this.to = this._range(ph.rain);
    this.fade = 0;
    this.fadeLen = this._range(FADE);
    this.holdLeft = this._range(ph.hold);
  }
}
