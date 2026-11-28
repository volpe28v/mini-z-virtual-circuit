// DDLabo 風ドリフトトラックの絵 (ロゴ・文字は無し)。座標は写真 (1331 × 832 px) の位置で、S (mm/px) を掛けて世界座標 (mm) にする。
// - ペイント (青から緑のグラデーション、駐車枠、斜線の箱、旗模様、中央の円形の印) は、かすれた感じに焼き込んだ画像 (デカール) にして、1 回だけ作る
// - マットの周囲 (左右の道路、四隅の芝)、ひび割れ、補修跡は Path2D (ベクター)
// 描くのはブラウザ (document / Path2D が要る)。形の座標は定数なので、変えるときはこのファイルだけ直す。

export function makeRng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 一様 Catmull-Rom (閉じた曲線) を細かい折れ線にする
function spline(pts, sub = 6) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let k = 0; k < sub; k++) {
      const t = k / sub;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  return out;
}

// 縁をギザギザにする (閉じた折れ線。辺を細かく分けて、少しずらす)
function rough(pts, amp, rnd, step = 3) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < m; k++) {
      const f = k / m;
      out.push([a[0] + (b[0] - a[0]) * f + (rnd() - 0.5) * 2 * amp, a[1] + (b[1] - a[1]) * f + (rnd() - 0.5) * 2 * amp]);
    }
  }
  return out;
}

const polyPath = (ctx, pts) => {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
};

// かすれ: 小さな粒と大きな擦れを、透明に抜く (ペイントがはがれて、アスファルトが見える)
function wear(g, w, h, kpx, rnd, density) {
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  const n = Math.round((w * h * density) / (kpx * kpx));
  for (let i = 0; i < n; i++) {
    const r = (0.35 + rnd() ** 3 * 2.4) * kpx;
    g.fillStyle = `rgba(0,0,0,${(0.3 + rnd() * 0.7).toFixed(2)})`;
    g.beginPath();
    g.ellipse(rnd() * w, rnd() * h, r, r * (0.5 + rnd() * 0.6), rnd() * 3.14, 0, 6.2832);
    g.fill();
  }
  for (let i = 0; i < 26; i++) {
    const r = (10 + rnd() * 34) * kpx;
    const x = rnd() * w;
    const y = rnd() * h;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.1 + rnd() * 0.28;
    gr.addColorStop(0, `rgba(0,0,0,${a.toFixed(2)})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  g.restore();
}

// デカール: 写真の範囲 [x0,y0,x1,y1] (px) を、1mm あたり ppm 画素の画像に描く。draw(g) は写真の座標系で描く
function decal(S, box, ppm, seed, wearDensity, draw) {
  const [x0, y0, x1, y1] = box;
  const k = S * ppm; // 写真の 1px あたりの画素
  const w = Math.ceil((x1 - x0) * k);
  const h = Math.ceil((y1 - y0) * k);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const rnd = makeRng(seed);
  g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  draw(g, rnd, k);
  wear(g, w, h, ppm, rnd, wearDensity);
  return { canvas: c, x: x0 * S, y: y0 * S, w: (x1 - x0) * S, h: (y1 - y0) * S };
}

// marginMm: 写真の外側へ広げる余白 (mm)。外側の白線が写真の端を越えるので、マットを四方へ広げ、道路・芝を端まで延ばす
export function buildPadArt(S, ppm = 1.6, marginMm = 0) {
  const mp = marginMm / S; // 写真の px にした余白
  const decals = [];
  const WHITE = 'rgba(228,228,220,0.86)';

  // ---- 左の枠: 青い帯 (縦) → 下辺の青〜緑の帯、斜めに上がる緑のスウッシュ、斜線の箱、駐車枠、白い外形 ----
  decals.push(
    decal(S, [250, 268, 760, 800], ppm, 11, 0.012, (g, rnd) => {
      const fill = (pts, amp, style) => {
        polyPath(g, rough(pts, amp, rnd));
        g.fillStyle = style;
        g.fill();
      };
      const grad = (x0, y0, x1, y1, stops) => {
        const gr = g.createLinearGradient(x0, y0, x1, y1);
        for (const [o, c] of stops) gr.addColorStop(o, c);
        return gr;
      };
      // 青い帯 + 下辺の帯 (L 字)。右へ行くほど青から緑へ、右端は薄れる
      fill(
        [[265, 282], [320, 282], [320, 596], [326, 612], [342, 622], [380, 626], [450, 628], [560, 630], [640, 632], [690, 637], [726, 649], [716, 653], [290, 653], [268, 641], [264, 620]],
        0.55,
        grad(265, 0, 726, 0, [[0, 'rgba(26,124,168,0.9)'], [0.2, 'rgba(26,122,164,0.86)'], [0.42, 'rgba(34,134,142,0.82)'], [0.75, 'rgba(50,148,92,0.78)'], [1, 'rgba(60,154,60,0.45)']]),
      );
      // 帯の下の方は、色が薄れる (写真の縦帯は下で透ける)
      g.save();
      g.globalCompositeOperation = 'destination-out';
      const fade = g.createLinearGradient(0, 520, 0, 612);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(1, 'rgba(0,0,0,0.42)');
      g.fillStyle = fade;
      g.fillRect(262, 520, 62, 92);
      g.restore();
      // スウッシュ
      fill(
        [[533, 402], [536, 440], [555, 490], [590, 545], [640, 598], [690, 632], [725, 650], [748, 645], [722, 615], [680, 578], [628, 528], [588, 470], [562, 425], [545, 395]],
        0.6,
        grad(540, 395, 726, 650, [[0, 'rgba(34,130,150,0.1)'], [0.3, 'rgba(34,128,134,0.62)'], [0.7, 'rgba(46,144,96,0.74)'], [1, 'rgba(60,152,62,0.78)']]),
      );
      // 白いペイント
      g.strokeStyle = WHITE;
      g.lineWidth = 2.5;
      g.beginPath(); // 外形: 左辺 → 左下の角 → 下辺
      g.moveTo(263, 296);
      g.lineTo(263, 636);
      g.quadraticCurveTo(264, 652, 284, 652);
      g.lineTo(706, 652);
      g.stroke();
      g.beginPath(); // 斜線の箱 (左上の角が丸い)
      g.moveTo(263, 296);
      g.quadraticCurveTo(263, 279, 281, 278);
      g.lineTo(494, 278);
      g.quadraticCurveTo(514, 282, 515, 304);
      g.lineTo(513, 331);
      g.quadraticCurveTo(511, 335, 505, 335);
      g.lineTo(322, 335);
      g.stroke();
      g.save();
      polyPath(g, [[322, 280], [515, 280], [515, 335], [322, 335]]);
      g.clip();
      g.lineWidth = 1.8;
      g.strokeStyle = 'rgba(228,228,220,0.74)';
      g.beginPath();
      for (let x = 300; x < 560; x += 9.6) {
        g.moveTo(x, 340);
        g.lineTo(x + 62, 276);
      }
      g.stroke();
      g.restore();
      // 駐車枠 (中が抜けた細長い角丸)
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(232,232,224,0.82)';
      for (const y of [393, 449, 504, 560]) {
        g.beginPath(); // 角丸の細長い枠 (半径 3.5)
        g.moveTo(335.5, y - 3.5);
        g.lineTo(434.5, y - 3.5);
        g.arc(434.5, y, 3.5, -1.5708, 1.5708);
        g.lineTo(335.5, y + 3.5);
        g.arc(335.5, y, 3.5, 1.5708, 4.7124);
        g.closePath();
        g.stroke();
      }
      // 下の短い目印の線
      g.lineWidth = 1.7;
      g.beginPath();
      g.moveTo(432, 668);
      g.lineTo(432, 722);
      g.moveTo(405, 742);
      g.lineTo(405, 785);
      g.stroke();
    }),
  );

  // ---- 右の青いエリア: 青から緑へ、先が細くなるしずく形。縁に旗模様 ----
  decals.push(
    decal(S, [826, 166, 1166, 418], ppm, 23, 0.014, (g, rnd) => {
      const shape = spline([[838, 222], [848, 203], [875, 190], [915, 181], [955, 177], [1000, 184], [1050, 214], [1100, 275], [1130, 330], [1148, 380], [1151, 404], [1136, 368], [1112, 332], [1075, 308], [1030, 293], [985, 287], [940, 285], [895, 281], [862, 276], [844, 258], [838, 240]], 5);
      polyPath(g, rough(shape, 0.55, rnd, 2.5));
      const gr = g.createLinearGradient(838, 0, 1152, 0);
      gr.addColorStop(0, 'rgba(24,126,170,0.92)');
      gr.addColorStop(0.35, 'rgba(28,134,160,0.88)');
      gr.addColorStop(0.62, 'rgba(36,142,122,0.82)');
      gr.addColorStop(0.86, 'rgba(56,154,72,0.7)');
      gr.addColorStop(1, 'rgba(60,156,60,0.35)');
      g.fillStyle = gr;
      g.fill();
      // 旗模様の白い四角 (縁に沿って、少しずつ傾く)
      for (const [x, y, s, a] of [[853, 200, 17, -0.35], [900, 191, 18, 0.05], [938, 187, 17, 0.02], [980, 187, 19, 0], [850, 228, 20, 0.1], [862, 259, 18, 0.4], [896, 271, 18, 0.1], [944, 274, 17, 0.1]]) {
        g.save();
        g.translate(x, y);
        g.rotate(a);
        polyPath(g, rough([[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]], 0.7, rnd, 2));
        g.fillStyle = 'rgba(232,232,226,0.84)';
        g.fill();
        g.restore();
      }
    }),
  );

  // ---- 中央の円形の印 (文字なし): 外側のリング、内側のリング、中のうっすらした円 ----
  decals.push(
    decal(S, [888, 418, 1002, 532], ppm, 37, 0.01, (g) => {
      g.fillStyle = 'rgba(214,214,206,0.3)';
      g.beginPath();
      g.arc(945, 475, 40, 0, 6.2832);
      g.fill();
      g.strokeStyle = 'rgba(228,228,220,0.8)';
      g.lineWidth = 6;
      g.beginPath();
      g.arc(945, 475, 47, 0, 6.2832);
      g.stroke();
      g.lineWidth = 3;
      g.beginPath();
      g.arc(945, 475, 30, 0, 6.2832);
      g.stroke();
    }),
  );

  // ---- マットの周囲 (写真のとおり、マットの上に印刷されている): 左右の道路の縁線、四隅の芝 ----
  const poly = (pts) => {
    const p = new Path2D();
    pts.forEach(([x, y], i) => (i ? p.lineTo(x * S, y * S) : p.moveTo(x * S, y * S)));
    p.closePath();
    return p;
  };
  const grass = [
    poly([[232, -mp], [415, -mp], [415, 0], [630, 128], [632, 168], [560, 128], [450, 96], [340, 86], [232, 100]]),
    poly([[940, -mp], [1100, -mp], [1100, 46], [1010, 20], [940, 0]]),
    poly([[232, 832 + mp], [232, 792], [300, 806], [370, 832], [370, 832 + mp]]),
    poly([[930, 832 + mp], [930, 832], [1000, 812], [1100, 792], [1100, 832 + mp]]),
    // 左右の端の細い芝 (写真では端にある。広げたマットの端 (枠) に置き直す)
    poly([[-mp, -mp], [-mp + 20, -mp], [-mp + 20, 262], [-mp, 262]]),
    poly([[-mp, 582], [-mp + 20, 582], [-mp + 20, 832 + mp], [-mp, 832 + mp]]),
    poly([[1331 + mp - 20, -mp], [1331 + mp, -mp], [1331 + mp, 232], [1331 + mp - 20, 232]]),
    poly([[1331 + mp - 20, 586], [1331 + mp, 586], [1331 + mp, 832 + mp], [1331 + mp - 20, 832 + mp]]),
  ];
  const roadLines = new Path2D();
  // 左右の端の縦線は、大きなコーナーの白い破線と重なるので引かない。道路の内側の縁線も、コーナーの破線に届かない長さにする
  for (const [x, y0, y1] of [[232, -mp, 76], [232, 820, 832 + mp], [1102, -mp, 32], [1102, 820, 832 + mp]]) {
    roadLines.moveTo(x * S, y0 * S);
    roadLines.lineTo(x * S, y1 * S);
  }
  const roads = [poly([[18, -mp], [232, -mp], [232, 832 + mp], [18, 832 + mp]]), poly([[1102, -mp], [1313, -mp], [1313, 832 + mp], [1102, 832 + mp]])];

  // ---- 路面の質感: ひび割れ (細い黒い枝)、補修跡 (うっすら暗い四角) ----
  const rnd = makeRng(777);
  const cracks = new Path2D();
  const MW = 1331 * S;
  const MH = 832 * S;
  const walk = (x, y, ang, n, depth) => {
    cracks.moveTo(x, y);
    for (let i = 0; i < n; i++) {
      ang += (rnd() - 0.5) * 1.3;
      const st = 2 + rnd() * 5;
      x += Math.cos(ang) * st;
      y += Math.sin(ang) * st;
      cracks.lineTo(x, y);
      if (depth < 2 && rnd() < 0.07) {
        const px = x;
        const py = y;
        walk(x, y, ang + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.8), 6 + Math.floor(rnd() * 16), depth + 1);
        cracks.moveTo(px, py);
      }
    }
  };
  const m = marginMm;
  for (let i = 0; i < 170; i++) walk(rnd() * (MW + 2 * m) - m, rnd() * (MH + 2 * m) - m, rnd() * 6.2832, 12 + Math.floor(rnd() * 34), 0);
  const patches = [];
  for (let i = 0; i < 9; i++) patches.push([rnd() * (MW + 2 * m) - m, rnd() * (MH + 2 * m) - m, 90 + rnd() * 160, 35 + rnd() * 60, (rnd() - 0.5) * 0.5, rnd() < 0.7 ? 1 : -1]);

  return { decals, grass, roads, roadLines, cracks, patches, mat: [MW, MH], margin: marginMm };
}

export function drawPadArt(ctx, art, P) {
  const [MW, MH] = art.mat;
  const m = art.margin;
  // マットの下地 (アスファルト)。写真の外側にも余白を広げている。マットの外は真っ黒 (renderer の下地)
  ctx.fillStyle = P.asphalt;
  ctx.fillRect(-m, -m, MW + 2 * m, MH + 2 * m);
  ctx.fillStyle = 'rgba(150,150,150,0.2)'; // 写真のアスファルトは、もう少し明るい中間のグレー
  ctx.fillRect(-m, -m, MW + 2 * m, MH + 2 * m);
  // 左右の道路は、ほんの少し明るい
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (const r of art.roads) ctx.fill(r);
  // 補修跡と、ひび割れ
  for (const [x, y, w, h, a, s] of art.patches) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = s > 0 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.035)';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 0.9;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.34)';
  ctx.lineWidth = 0.5;
  ctx.stroke(art.cracks);
  // 芝 (四隅) と、道路の白い縁線
  ctx.fillStyle = P.grass;
  for (const g of art.grass) ctx.fill(g);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 2;
  for (const g of art.grass) ctx.stroke(g);
  ctx.strokeStyle = 'rgba(228,228,220,0.62)';
  ctx.lineWidth = 3.2;
  ctx.stroke(art.roadLines);
  // ペイント
  for (const d of art.decals) ctx.drawImage(d.canvas, d.x, d.y, d.w, d.h);
}
