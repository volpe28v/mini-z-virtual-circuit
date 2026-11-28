// 設定パネル、再生/停止、UI の非表示と再表示。
import { SCHEMA, BOOLEANS, CHOICES } from './settings.js';

const $ = (id) => document.getElementById(id);

const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const ICON_PLAY =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M7 4l13 8-13 8z"/></svg>';

function fmt(def, v) {
  if (def.percent) return `${Math.round(v * 100)}%`;
  const digits = def.step < 0.1 ? 2 : def.step < 1 ? 1 : 0;
  return `${v.toFixed(digits)}${def.unit && def.unit !== '%' ? ' ' + def.unit : ''}`;
}

// handlers: { onChange(key), onReset(), onSave() }
export function createUI(settings, handlers) {
  const panel = $('panel');
  const rows = new Map();
  let statusEl = null;

  // ---- パネルの組み立て ----
  panel.innerHTML = `
    <header><h1>設定</h1><button class="close" id="panelClose" aria-label="閉じる">✕</button></header>
    <div id="rows"></div>
    <div class="buttons">
      <button id="btnHidePanel">UI を非表示 (画面の左右の端をタップで再表示)</button>
      <button id="btnReset" class="danger">設定をリセット</button>
    </div>
    <div class="status" id="status"></div>
    <p class="hint">実物の車体を載せたまま触るときは、画面の端のボタンを使ってください。</p>`;
  const rowsEl = panel.querySelector('#rows');

  // 選択式 (コースなど): ボタンの並び
  for (const c of CHOICES) {
    const row = document.createElement('div');
    row.className = 'row choice';
    row.innerHTML = `<label><span>${c.label}</span></label><div class="seg" role="radiogroup"></div>`;
    rowsEl.appendChild(row);
    const seg = row.querySelector('.seg');
    const buttons = new Map();
    for (const [value, name] of c.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = name;
      btn.setAttribute('role', 'radio');
      btn.addEventListener('click', () => {
        if (settings[c.key] === value) return;
        settings[c.key] = value;
        sync();
        handlers.onChange(c.key);
      });
      seg.appendChild(btn);
      buttons.set(value, btn);
    }
    const sync = () => {
      for (const [value, btn] of buttons) {
        btn.setAttribute('aria-checked', String(settings[c.key] === value));
        btn.classList.toggle('on', settings[c.key] === value);
      }
    };
    rows.set(c.key, { choice: sync });
  }
  for (const b of BOOLEANS) {
    if (b.key === 'playing') continue; // 再生/停止は専用ボタン
    const label = document.createElement('label');
    label.className = 'check';
    label.innerHTML = `<input type="checkbox" data-key="${b.key}" /><span>${b.label}</span>`;
    rowsEl.appendChild(label);
    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      settings[b.key] = input.checked;
      handlers.onChange(b.key);
    });
    rows.set(b.key, { input });
  }
  for (const s of SCHEMA) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label for="r_${s.key}"><span>${s.label}</span><output></output></label>
      <input id="r_${s.key}" type="range" min="${s.min}" max="${s.max}" step="${s.step}" />`;
    rowsEl.appendChild(row);
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    input.addEventListener('input', () => {
      settings[s.key] = Number(input.value);
      out.textContent = fmt(s, settings[s.key]);
      handlers.onChange(s.key);
    });
    rows.set(s.key, { input, out, def: s });
  }

  function syncAll() {
    for (const c of CHOICES) rows.get(c.key).choice();
    for (const b of BOOLEANS) {
      const r = rows.get(b.key);
      if (r) r.input.checked = !!settings[b.key];
    }
    for (const s of SCHEMA) {
      const r = rows.get(s.key);
      r.input.value = String(settings[s.key]);
      r.out.textContent = fmt(s, settings[s.key]);
    }
    syncPlay();
  }

  // ---- 再生/停止 ----
  const btnPlay = $('btnPlay');
  function syncPlay() {
    btnPlay.innerHTML = settings.playing ? ICON_PAUSE : ICON_PLAY;
    btnPlay.setAttribute('aria-pressed', String(!settings.playing));
  }
  btnPlay.addEventListener('click', () => {
    settings.playing = !settings.playing;
    syncPlay();
    handlers.onChange('playing');
  });

  // ---- パネルの開閉 ----
  const openPanel = (open) => {
    panel.hidden = !open;
  };
  $('btnMenu').addEventListener('click', () => openPanel(panel.hidden));
  $('panelClose').addEventListener('click', () => openPanel(false));

  // ---- UI 非表示 / 再表示 ----
  const edges = [$('edgeL'), $('edgeR')];
  function setUIHidden(hidden) {
    document.body.classList.toggle('ui-hidden', hidden);
    for (const e of edges) e.hidden = !hidden;
    if (hidden) {
      openPanel(false);
    }
  }
  $('btnHide').addEventListener('click', () => setUIHidden(true));
  $('btnHidePanel').addEventListener('click', () => setUIHidden(true));
  for (const e of edges) {
    e.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      setUIHidden(false);
    });
  }

  // ---- リセット (2 回押しで実行。ダイアログは使わない) ----
  const btnReset = $('btnReset');
  let armTimer = 0;
  btnReset.addEventListener('click', () => {
    if (!btnReset.classList.contains('armed')) {
      btnReset.classList.add('armed');
      btnReset.textContent = 'もう一度押すとリセットします';
      armTimer = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    handlers.onReset();
    syncAll();
  });
  function disarm() {
    clearTimeout(armTimer);
    btnReset.classList.remove('armed');
    btnReset.textContent = '設定をリセット';
  }

  statusEl = $('status');
  syncAll();

  return {
    syncAll,
    setStatus(text) {
      if (!panel.hidden) statusEl.textContent = text;
    },
    panelOpen: () => !panel.hidden,
    setUIHidden,
  };
}
