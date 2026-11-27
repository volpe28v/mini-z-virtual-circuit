// 設定のスキーマ・既定値・検証・保存。DOM に依存しない (storage / env は引数で受ける)。

export const STORAGE_KEY = 'mzvc.settings.v1';
// 既定値を変えたときに上げる。旧バージョンで保存された「旧既定値のまま」の項目だけ新既定値へ移行する
export const SETTINGS_VERSION = 3;
// v2: コース幅 90 → 108mm (+20%)、v3: 108 → 119mm (さらに +10%)
const MIGRATIONS = [{ key: 'trackWidth', from: [90, 108], since: 3 }];

// rebuild: true の項目は、タイヤ痕などワールドの再生成が必要
export const SCHEMA = [
  { key: 'speed', label: '走行速度', unit: 'mm/s', min: 150, max: 1600, step: 10, def: 600, rebuild: true },
  { key: 'maxDrift', label: '最大ドリフト角度', unit: '°', min: 0, max: 60, step: 1, def: 35, rebuild: true },
  { key: 'driftStrength', label: 'ドリフト強度', unit: '', min: 0, max: 2, step: 0.05, def: 1, rebuild: true },
  { key: 'courseScale', label: 'コーススケール', unit: '×', min: 0.5, max: 2, step: 0.01, def: 1 },
  { key: 'trackWidth', label: 'コース幅', unit: 'mm', min: 60, max: 180, step: 1, def: 119, rebuild: true },
  { key: 'carX', label: '車両位置 X', unit: '%', min: 0.1, max: 0.9, step: 0.01, def: 0.5, percent: true },
  { key: 'carY', label: '車両位置 Y', unit: '%', min: 0.1, max: 0.9, step: 0.01, def: 0.6, percent: true },
  { key: 'brightness', label: '路面の明るさ', unit: '', min: 0.5, max: 1.5, step: 0.01, def: 1 },
  { key: 'wander', label: 'ライン取りのふらつき', unit: '', min: 0, max: 2, step: 0.05, def: 1, rebuild: true },
  { key: 'carry', label: '引きずり (コーナー後の余韻)', unit: '', min: 0, max: 2, step: 0.05, def: 1, rebuild: true },
  { key: 'feint', label: 'フェイント (振り出し)', unit: '', min: 0, max: 2, step: 0.05, def: 1, rebuild: true },
  { key: 'night', label: '夜の暗さ (時間帯の自動変化が OFF のとき)', unit: '', min: 0, max: 1, step: 0.05, def: 0 },
  { key: 'wet', label: 'ウェット路面 (天候の自動変化が OFF のとき)', unit: '', min: 0, max: 1, step: 0.05, def: 0 },
  { key: 'smoke', label: 'タイヤスモーク', unit: '', min: 0, max: 3, step: 0.05, def: 1 },
  { key: 'motionBlur', label: 'モーションブラー', unit: '', min: 0, max: 0.6, step: 0.05, def: 0.2 },
  { key: 'carLength', label: '車両の長さ', unit: 'mm', min: 100, max: 220, step: 1, def: 150 },
  { key: 'carWidth', label: '車両の幅', unit: 'mm', min: 50, max: 100, step: 1, def: 70 },
  { key: 'renderScale', label: '描画解像度', unit: '', min: 0.5, max: 1, step: 0.05, def: 1 },
];

export const BOOLEANS = [
  { key: 'showCar', label: '仮想車両を表示 (デバッグ)', def: false },
  { key: 'autoTime', label: '時間帯を自動で変える (昼→夕方→夜)', def: true },
  { key: 'autoWeather', label: '天候を自動で変える (晴れ→雨→晴れ)', def: true },
  { key: 'autoRes', label: '重いときは解像度を自動で下げる', def: true },
  { key: 'playing', label: '再生', def: true },
];

export const PX_PER_MM_RANGE = { min: 2, max: 12 };

// 画面の実寸 (CSS px / mm) の推定。キャリブレーションで上書きされる。
export function guessPxPerMm(screenWidth, screenHeight) {
  const shortSide = Math.min(screenWidth || 0, screenHeight || 0);
  if (shortSide === 744) return 6.42; // iPad mini (163 ppi 相当)
  if (shortSide >= 768) return 5.2; // 9.7 / 10.2 / 10.9 / 11 インチ (132 ppi 相当)
  return 3.78; // 一般的な 96 ppi
}

export function defaults(env = {}) {
  const d = { version: SETTINGS_VERSION, pxPerMm: guessPxPerMm(env.screenWidth, env.screenHeight) };
  for (const s of SCHEMA) d[s.key] = s.def;
  for (const b of BOOLEANS) d[b.key] = b.def;
  return d;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// 任意のオブジェクトを検証し、不正な値は既定値に戻して返す。
export function sanitize(raw, env = {}) {
  const d = defaults(env);
  const out = { ...d };
  if (!raw || typeof raw !== 'object') return out;
  for (const s of SCHEMA) {
    const v = raw[s.key];
    if (typeof v === 'number' && Number.isFinite(v)) out[s.key] = clamp(v, s.min, s.max);
  }
  for (const b of BOOLEANS) {
    if (typeof raw[b.key] === 'boolean') out[b.key] = raw[b.key];
  }
  // 旧バージョンの保存値が旧既定値のままなら、新しい既定値を使う
  const savedVersion = typeof raw.version === 'number' ? raw.version : 1;
  for (const m of MIGRATIONS) {
    if (savedVersion < m.since && m.from.includes(raw[m.key])) out[m.key] = d[m.key];
  }
  const p = raw.pxPerMm;
  if (typeof p === 'number' && Number.isFinite(p)) {
    out.pxPerMm = clamp(p, PX_PER_MM_RANGE.min, PX_PER_MM_RANGE.max);
  }
  return out;
}

export function loadSettings(storage, env = {}) {
  try {
    const text = storage && storage.getItem(STORAGE_KEY);
    if (!text) return defaults(env);
    return sanitize(JSON.parse(text), env);
  } catch {
    return defaults(env);
  }
}

export function saveSettings(storage, settings) {
  try {
    if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false; // プライベートモード等で保存できなくても動作は続ける
  }
}
