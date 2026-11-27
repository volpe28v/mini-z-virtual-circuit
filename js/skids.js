// タイヤ痕。実際の走行でドリフト中の後輪の位置を記録し、走行距離で「3 周ぶん」だけ残す (DOM 非依存)。
// 痕はワールド座標の折れ線 (チャンク) として持ち、描画側が Path2D にする。
import { carGeometry } from './camera.js';

export const KEEP_LAPS = 3; // 残す周回数 (走行距離で数える)
const BUCKET_EDGES = [0.25, 0.55, 0.8]; // 最大ドリフト角に対する比。超えるごとに濃くなる
const MIN_SPACING = 5; // 折れ線の点の間隔 (mm)
const CHUNK_POINTS = 80; // 1 チャンクの点数 (これを超えたら区切る)
const MIN_POINTS = 4; // これより短い痕は捨てる

export class SkidMarks {
  // lapLength: コースの全長 (mm)
  constructor(lapLength) {
    this.lapLength = lapLength;
    this.chunks = []; // 完成した痕: { b, pts: number[], s0, s1 } (記録した順 = 走行距離順)
    this.open = [null, null]; // 左右の後輪の、記録中の痕
    this.version = 0; // 完成した痕が増減したら増える (描画側が Path2D を作り直す合図)
  }

  reset() {
    this.chunks.length = 0;
    this.open[0] = this.open[1] = null;
    this.version++;
  }

  // 車両 (position, heading, driftAngle, progress) の現在の状態を記録する。固定ステップごとに呼ぶ。
  update(veh, st) {
    const maxAngle = (st.maxDrift * Math.PI) / 180;
    let b = -1;
    if (maxAngle > 0) {
      const ratio = Math.abs(veh.driftAngle) / maxAngle;
      for (let i = 0; i < BUCKET_EDGES.length; i++) if (ratio >= BUCKET_EDGES[i]) b = i;
    }
    if (b < 0) {
      this._closeAll();
    } else {
      const g = carGeometry(st.carLength, st.carWidth);
      const fx = Math.cos(veh.heading);
      const fy = Math.sin(veh.heading);
      const rx = -fy;
      const ry = fx;
      for (let w = 0; w < 2; w++) {
        const side = w === 0 ? -1 : 1;
        const px = veh.position.x - fx * (g.wheelbase / 2) + rx * side * (g.track / 2);
        const py = veh.position.y - fy * (g.wheelbase / 2) + ry * side * (g.track / 2);
        let cur = this.open[w];
        if (cur && cur.b !== b) {
          // 濃さの段階が変わったら区切る (つなぎ目が切れないよう、最後の点から続ける)
          const last = this._close(w);
          cur = null;
          this._begin(w, b, veh.progress, last);
          cur = this.open[w];
        }
        if (!cur) {
          this._begin(w, b, veh.progress, null);
          cur = this.open[w];
        }
        const n = cur.pts.length;
        if (n === 0 || Math.hypot(px - cur.pts[n - 2], py - cur.pts[n - 1]) >= MIN_SPACING) {
          cur.pts.push(px, py);
          cur.s1 = veh.progress;
          if (cur.pts.length >= CHUNK_POINTS * 2) {
            const last = this._close(w);
            this._begin(w, b, veh.progress, last);
          }
        }
      }
    }
    this._prune(veh.progress);
  }

  _begin(w, b, s, carry) {
    this.open[w] = { b, pts: carry ? carry.slice() : [], s0: s, s1: s };
  }

  // 記録中の痕を完成させる。続きの点 (最後の 1 点) を返す
  _close(w) {
    const cur = this.open[w];
    this.open[w] = null;
    if (!cur) return null;
    const n = cur.pts.length;
    if (n >= MIN_POINTS * 2) {
      this.chunks.push(cur);
      this.version++;
    }
    return n >= 2 ? cur.pts.slice(n - 2) : null;
  }

  _closeAll() {
    this._close(0);
    this._close(1);
  }

  // 走行距離で 3 周より前の痕を消す
  _prune(progress) {
    const limit = progress - KEEP_LAPS * this.lapLength;
    let drop = 0;
    while (drop < this.chunks.length && this.chunks[drop].s1 < limit) drop++;
    if (drop > 0) {
      this.chunks.splice(0, drop);
      this.version++;
    }
  }
}
