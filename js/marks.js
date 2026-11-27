// ラバーライン (走行ラインの黒ずみ) の事前計算。車両ロジックそのものを基準走行として回し、中心の軌跡を記録する。
// ドリフトで付くタイヤ痕は、実際の走行から記録する (js/skids.js)。
import { Vehicle } from './vehicle.js';

const LAPS = [
  { scale: 0.88, bias: -6 },
  { scale: 1.0, bias: 3 },
  { scale: 1.1, bias: 8 },
];

// 戻り値: 走行ライン中心のポリライン [x0,y0,x1,y1,...]
export function simulateRubber(track, settings) {
  const veh = new Vehicle(track);
  const st = { ...settings };
  const dt = 1 / 120;
  const rubber = [];
  for (const lap of LAPS) {
    veh.reset(0);
    veh.driftScale = lap.scale;
    veh.offsetBias = lap.bias;
    let lastRubber = -1e9;
    while (veh.progress < track.length) {
      veh.update(dt, st);
      if (veh.progress - lastRubber >= 15) {
        rubber.push(veh.position.x, veh.position.y);
        lastRubber = veh.progress;
      }
    }
  }
  return rubber;
}
