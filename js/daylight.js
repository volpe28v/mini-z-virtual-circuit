// 時間帯の自動変化 (DOM 非依存)。昼 → 夕方 → 夜 → 明け方 → 昼 を、時間でゆるやかに切り替える。
// dark = 暗さ (0 昼 〜 1 夜)、warm = 夕焼け・朝焼けの色味 (0〜1)。

// キーフレーム: [経過秒, dark, warm]。間は smoothstep でなめらかにつなぐ
const KEYS = [
  [0, 0, 0],
  [60, 0, 0], // 昼
  [85, 0.25, 1], // 夕焼け
  [110, 0.8, 0.2],
  [125, 1, 0], // 夜
  [185, 1, 0],
  [210, 0.5, 0.6], // 明け方
  [235, 0.05, 0.3],
  [250, 0, 0],
];
export const PERIOD = KEYS[KEYS.length - 1][0];

function smooth(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

// 経過秒 t (周期で折り返す) の { dark, warm }
export function daylightAt(t) {
  const x = ((t % PERIOD) + PERIOD) % PERIOD;
  for (let i = 1; i < KEYS.length; i++) {
    if (x <= KEYS[i][0]) {
      const [t0, d0, w0] = KEYS[i - 1];
      const [t1, d1, w1] = KEYS[i];
      const u = smooth((x - t0) / (t1 - t0));
      return { dark: d0 + (d1 - d0) * u, warm: w0 + (w1 - w0) * u };
    }
  }
  return { dark: 0, warm: 0 };
}

export function daylightLabel(dark, warm, rising) {
  if (dark < 0.12) return '昼';
  if (dark > 0.85) return '夜';
  return rising ? '明け方' : '夕方';
}

export class TimeOfDay {
  constructor(start = 0) {
    this.t = start;
    this.dark = 0;
    this.warm = 0;
    this.label = '昼';
    this._apply();
  }

  _apply() {
    const a = daylightAt(this.t);
    this.dark = a.dark;
    this.warm = a.warm;
    const x = ((this.t % PERIOD) + PERIOD) % PERIOD;
    this.label = daylightLabel(a.dark, a.warm, x > 125 + 30);
  }

  update(dt) {
    this.t += dt;
    this._apply();
  }
}
