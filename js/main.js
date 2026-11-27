// エントリ: 設定の読み込み、描画ループ、リサイズ、可視性復帰、Wake Lock、Service Worker。
import { loadSettings, saveSettings, defaults, sanitize } from './settings.js';
import { Track } from './track.js';
import { Vehicle } from './vehicle.js';
import { makeAllTextures } from './textures.js';
import { Renderer } from './renderer.js';
import { createUI } from './ui.js';

const params = new URLSearchParams(location.search);
const overview = params.has('overview'); // コース全体の俯瞰 (確認用)

const env = { screenWidth: screen.width, screenHeight: screen.height };
let storage = null;
try {
  storage = window.localStorage;
} catch {
  storage = null; // Cookie 無効などでアクセスできない場合
}
const settings = loadSettings(storage, env);

const canvas = document.getElementById('scene');
const track = new Track();
const vehicle = new Vehicle(track);
const textures = makeAllTextures();
const renderer = new Renderer(canvas, track, textures);

// ---- 保存・再構築 (デバウンス) ----
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(storage, settings), 200);
}
let rebuildTimer = 0;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => renderer.buildWorld(settings), 150);
}
const REBUILD_KEYS = new Set(['speed', 'maxDrift', 'driftStrength', 'trackWidth']);

function applyBrightness() {
  canvas.style.filter = settings.brightness === 1 ? '' : `brightness(${settings.brightness})`;
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.resize(w, h, window.devicePixelRatio || 1, settings.renderScale);
}

const ui = createUI(settings, {
  onChange(key) {
    if (REBUILD_KEYS.has(key)) scheduleRebuild();
    if (key === 'brightness') applyBrightness();
    if (key === 'renderScale') resize();
    if (key === 'playing') {
      if (settings.playing) acquireWakeLock();
      last = performance.now();
    }
    scheduleSave();
  },
  onReset() {
    const d = defaults(env);
    Object.assign(settings, d, { pxPerMm: settings.pxPerMm }); // 実寸の校正は残す
    applyBrightness();
    resize();
    scheduleRebuild();
    scheduleSave();
  },
  onSave() {
    saveSettings(storage, settings);
  },
});

resize();
renderer.buildWorld(settings);
applyBrightness();
document.getElementById('loading').classList.add('done');

let rTimer = 0;
function onResize() {
  clearTimeout(rTimer);
  rTimer = setTimeout(resize, 60);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

// ---- 描画ループ ----
let last = performance.now();
let frames = 0;
let fpsAt = last;
let fps = 0;
const cam = { px: 0, py: 0, heading: 0, k: 1, ax: 0, ay: 0 };

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (!(dt > 0)) dt = 0;
  if (dt > 0.05) dt = 0.05; // タブ切り替え後などの大きな飛びを防ぐ
  if (settings.playing) vehicle.update(dt, settings);

  const w = window.innerWidth;
  const h = window.innerHeight;
  if (overview) {
    const b = track.bounds();
    cam.px = (b.minX + b.maxX) / 2;
    cam.py = (b.minY + b.maxY) / 2;
    cam.heading = -Math.PI / 2;
    cam.k = Math.min(w / (b.maxX - b.minX + 400), h / (b.maxY - b.minY + 400));
    cam.ax = w / 2;
    cam.ay = h / 2;
  } else {
    cam.px = vehicle.position.x;
    cam.py = vehicle.position.y;
    cam.heading = vehicle.heading;
    cam.k = settings.pxPerMm * settings.courseScale;
    cam.ax = w * settings.carX;
    cam.ay = h * settings.carY;
  }
  renderer.render(cam, settings, vehicle, overview);

  frames++;
  if (now - fpsAt >= 1000) {
    fps = (frames * 1000) / (now - fpsAt);
    frames = 0;
    fpsAt = now;
    const lap = Math.floor(vehicle.progress / track.length) + 1;
    ui.setStatus(
      `${fps.toFixed(0)} fps · 周回 ${lap} · 速度 ${vehicle.speed.toFixed(0)} mm/s · ドリフト ${((vehicle.driftAngle * 180) / Math.PI).toFixed(0)}° · ${settings.pxPerMm.toFixed(2)} px/mm`,
    );
  }
}
requestAnimationFrame(frame);

// ---- Wake Lock (対応環境のみ。非対応でも動作は続ける) ----
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator) || wakeLock || !settings.playing) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}
acquireWakeLock();

// バックグラウンドから復帰したら時刻基準を取り直し、Wake Lock を再取得
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    last = performance.now();
    fpsAt = last;
    frames = 0;
    acquireWakeLock();
  }
});
window.addEventListener('pageshow', () => {
  last = performance.now();
  acquireWakeLock();
});

// ピンチズームやダブルタップ拡大を抑止 (iOS Safari)
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault());
}
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- Service Worker (相対パス。GitHub Pages のサブディレクトリでも動く) ----
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW register failed', e));
  });
}

// テスト用に公開 (Playwright から状態を確認する)
window.__mzvc = { settings, vehicle, track, renderer, sanitize };
