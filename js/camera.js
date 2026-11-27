// カメラ: 車両が画面上のアンカーに固定され、車体の前方が画面の上を向くようにワールドを動かす。
// 画面座標 = アンカー + k · Rot(-π/2 - heading) · (ワールド - 車両位置)

// 行列は Canvas の setTransform(a, b, c, d, e, f) の並び。scale は CSS px / mm に掛ける追加倍率 (dpr 等)。
export function cameraMatrix(cam, scale = 1) {
  const r = -Math.PI / 2 - cam.heading;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const k = cam.k * scale;
  return {
    a: k * c,
    b: k * s,
    c: -k * s,
    d: k * c,
    e: cam.ax * scale - k * (c * cam.px - s * cam.py),
    f: cam.ay * scale - k * (s * cam.px + c * cam.py),
  };
}

export function worldToScreen(cam, wx, wy) {
  const m = cameraMatrix(cam, 1);
  return { x: m.a * wx + m.c * wy + m.e, y: m.b * wx + m.d * wy + m.f };
}

// 画面の四隅のうちアンカーから最も遠い点までの距離 (mm)。芝の塗りつぶし範囲に使う。
export function viewRadiusMm(cam, width, height) {
  const dx = Math.max(cam.ax, width - cam.ax);
  const dy = Math.max(cam.ay, height - cam.ay);
  return Math.hypot(dx, dy) / cam.k;
}

// デバッグ表示の車輪の配置。車両の長さ・幅 (mm) に比例させる。
// 基準は長さ 150mm / 幅 70mm の車体で、ホイールベース 95mm、トレッド 55mm、タイヤ 6×12mm。
export function carGeometry(length, width) {
  return {
    wheelbase: (length * 95) / 150, // 前後の車輪の間隔
    track: (width * 55) / 70, // 左右の車輪の間隔
    wheelW: (width * 6) / 70, // タイヤの幅
    wheelH: (length * 12) / 150, // タイヤの直径
  };
}
