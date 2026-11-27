// 路面・芝・砂利などのタイルをプログラムで生成する。すべて周期的 (継ぎ目が出ない)。
// 生成は起動時に 1 回だけ。毎フレームは CanvasPattern としてワールド座標に固定して塗る。

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 周期的な value noise。値は 0〜1
function noiseField(size, freq, rng) {
  const lat = new Float32Array(freq * freq);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const ix0 = new Int32Array(size);
  const ix1 = new Int32Array(size);
  const fx = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const u = (x * freq) / size;
    const i = Math.floor(u);
    const f = u - i;
    ix0[x] = i % freq;
    ix1[x] = (i + 1) % freq;
    fx[x] = f * f * (3 - 2 * f);
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = (y * freq) / size;
    const j = Math.floor(v);
    const f = v - j;
    const fy = f * f * (3 - 2 * f);
    const r0 = (j % freq) * freq;
    const r1 = ((j + 1) % freq) * freq;
    for (let x = 0; x < size; x++) {
      const a = lat[r0 + ix0[x]] + (lat[r0 + ix1[x]] - lat[r0 + ix0[x]]) * fx[x];
      const b = lat[r1 + ix0[x]] + (lat[r1 + ix1[x]] - lat[r1 + ix0[x]]) * fx[x];
      out[y * size + x] = a + (b - a) * fy;
    }
  }
  return out;
}

// 複数オクターブの合成。戻りは約 -1〜1
function fbm(size, octaves, rng) {
  const out = new Float32Array(size * size);
  let total = 0;
  for (const [freq, amp] of octaves) {
    const n = noiseField(size, freq, rng);
    for (let i = 0; i < out.length; i++) out[i] += (n[i] - 0.5) * 2 * amp;
    total += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function makeAsphalt(size = 512) {
  const rng = mulberry32(101);
  const fine = noiseField(size, size / 4, rng);
  const mid = noiseField(size, size / 16, rng);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    let g = 58 + (fine[i] - 0.5) * 22 + (mid[i] - 0.5) * 14 + (rng() - 0.5) * 18;
    const r = rng();
    if (r < 0.025) g += 25 + rng() * 40; // 明るい骨材
    else if (r < 0.04) g -= 18; // 暗い粒
    d[i * 4] = clamp255(g);
    d[i * 4 + 1] = clamp255(g + 1);
    d[i * 4 + 2] = clamp255(g + 3);
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// 大きな色むら (RGBA)。路面と芝の両方に重ねる
export function makeMottle(size = 1024) {
  const rng = mulberry32(202);
  const n = fbm(size, [[4, 1], [8, 0.7], [16, 0.5], [32, 0.3]], rng);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(-1, Math.min(1, n[i] * 2.4));
    if (v > 0) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
      d[i * 4 + 3] = v * 0.1 * 255;
    } else {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0;
      d[i * 4 + 3] = -v * 0.22 * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function makeGrass(size = 1024) {
  const rng = mulberry32(303);
  const n = fbm(size, [[8, 1], [16, 0.8], [32, 0.6], [64, 0.4]], rng);
  const n2 = fbm(size, [[16, 1], [48, 0.6]], rng);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const w = rng() - 0.5;
    const k = 1 + n[i] * 0.3 + w * 0.22;
    d[i * 4] = clamp255(46 * k + n2[i] * 6);
    d[i * 4 + 1] = clamp255(82 * k + n2[i] * 10);
    d[i * 4 + 2] = clamp255(34 * k);
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // 草の筋。端をまたぐものは反対側にも描いて周期的にする
  const blade = (x, y, len, ang, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const px = x + ox;
        const py = y + oy;
        if (px < -20 || px > size + 20 || py < -20 || py > size + 20) continue;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
        ctx.stroke();
      }
    }
  };
  ctx.lineCap = 'round';
  for (let i = 0; i < 14000; i++) {
    const ang = -Math.PI / 2 + (rng() - 0.5) * 1.3;
    const light = rng() < 0.5;
    blade(
      rng() * size,
      rng() * size,
      5 + rng() * 9,
      ang,
      light ? `rgba(${95 + rng() * 30},${145 + rng() * 30},${60 + rng() * 20},0.32)` : `rgba(${20 + rng() * 15},${50 + rng() * 15},${18},0.38)`,
      1 + rng() * 0.8,
    );
  }
  return c;
}

export function makeGravel(size = 512) {
  const rng = mulberry32(404);
  const n = fbm(size, [[16, 1], [48, 0.7]], rng);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const g = 128 + n[i] * 18 + (rng() - 0.5) * 30;
    d[i * 4] = clamp255(g + 10);
    d[i * 4 + 1] = clamp255(g - 4);
    d[i * 4 + 2] = clamp255(g - 28);
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 2200; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 1 + rng() * 2.2;
    const light = rng() < 0.45;
    ctx.fillStyle = light ? `rgba(220,205,170,${0.25 + rng() * 0.3})` : `rgba(60,48,34,${0.25 + rng() * 0.3})`;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const px = x + ox;
        const py = y + oy;
        if (px < -5 || px > size + 5 || py < -5 || py > size + 5) continue;
        ctx.beginPath();
        ctx.ellipse(px, py, r, r * (0.7 + rng() * 0.3), rng() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return c;
}

// 汚れ・擦れ (RGBA の細かい斑点)。縁石などに重ねる
export function makeSpeckle(size = 256) {
  const rng = mulberry32(505);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const dark = rng() < 0.55;
    const v = dark ? 0 : 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = rng() * (dark ? 0.2 : 0.13) * 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// タイル 1 枚が覆うワールド上の長さ (mm)
export const TILE_MM = { asphalt: 70, mottleA: 1400, mottleB: 850, grass: 220, gravel: 100, speckle: 40 };

export function makeAllTextures() {
  return {
    asphalt: makeAsphalt(),
    mottle: makeMottle(),
    grass: makeGrass(),
    gravel: makeGravel(),
    speckle: makeSpeckle(),
  };
}
