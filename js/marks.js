// タイヤ痕の事前計算。車両ロジックそのものを基準走行として回し、ドリフト中の後輪位置を記録する。
import { Vehicle } from './vehicle.js';

const WHEELBASE = 95; // mm
const TRACK_WIDTH_CAR = 52; // mm (左右の輪の間隔)
const LAPS = [
  { scale: 0.88, bias: -6 },
  { scale: 1.0, bias: 3 },
  { scale: 1.1, bias: 8 },
];
const BUCKET_EDGES = [0.25, 0.55, 0.8]; // 最大角に対する比

// 戻り値:
//   buckets: 濃さ 3 段階 × ポリライン配列 (各ポリラインは [x0,y0,x1,y1,...])
//   rubber: 走行ライン中心のポリライン (黒ずみ用)
export function simulateMarks(track, settings) {
  const veh = new Vehicle(track);
  const st = { ...settings };
  const dt = 1 / 120;
  const maxAngle = Math.max(1e-6, (st.maxDrift * Math.PI) / 180);
  const buckets = [[], [], []];
  const rubber = [];

  for (const lap of LAPS) {
    veh.reset(0);
    veh.driftScale = lap.scale;
    veh.offsetBias = lap.bias;
    const endS = track.length;
    const cur = [null, null]; // 左右の輪の現在のポリライン {b, pts}
    let lastRubber = -1e9;
    while (veh.progress < endS) {
      veh.update(dt, st);
      const h = veh.heading;
      const fx = Math.cos(h);
      const fy = Math.sin(h);
      const rx = -fy;
      const ry = fx;
      const ratio = Math.abs(veh.driftAngle) / maxAngle;
      let b = -1;
      for (let i = 0; i < BUCKET_EDGES.length; i++) if (ratio >= BUCKET_EDGES[i]) b = i;
      for (let w = 0; w < 2; w++) {
        const side = w === 0 ? -1 : 1;
        const px = veh.position.x - fx * (WHEELBASE / 2) + rx * side * (TRACK_WIDTH_CAR / 2);
        const py = veh.position.y - fy * (WHEELBASE / 2) + ry * side * (TRACK_WIDTH_CAR / 2);
        const c = cur[w];
        if (b < 0) {
          if (c) {
            if (c.pts.length >= 8) buckets[c.b].push(c.pts);
            cur[w] = null;
          }
          continue;
        }
        if (!c || c.b !== b) {
          if (c && c.pts.length >= 8) buckets[c.b].push(c.pts);
          cur[w] = { b, pts: c ? c.pts.slice(-2) : [] };
        }
        const pts = cur[w].pts;
        const n = pts.length;
        if (n < 2 || Math.hypot(px - pts[n - 2], py - pts[n - 1]) >= 6) pts.push(px, py);
      }
      if (veh.progress - lastRubber >= 15) {
        rubber.push(veh.position.x, veh.position.y);
        lastRubber = veh.progress;
      }
    }
    for (const c of cur) if (c && c.pts.length >= 8) buckets[c.b].push(c.pts);
  }
  return { buckets, rubber };
}
