/**
 * 桌宠面容指纹：用 MediaPipe 人脸关键点做刚体对齐后的几何向量。
 * 不调聊天模型；比对在服务端做余弦相似度。
 */

/** 骨相稳定点：轮廓 + 鼻梁 + 眼角 + 颧骨，避开嘴唇/眼皮（表情会动） */
export const STABLE_IDX = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  1, 2, 4, 5, 6, 19, 94, 168, 197, 195,
  33, 133, 362, 263,
  116, 345, 123, 352, 205, 425, 50, 280,
];

export const FACEPRINT_DIM = STABLE_IDX.length * 3;
export const FACEPRINT_VERSION = 1;

function l2normalize(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const n = Math.sqrt(s) || 1;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

export function averageEmbeddings(list) {
  if (!list?.length) return null;
  const dim = list[0].length;
  const acc = new Array(dim).fill(0);
  let n = 0;
  for (const e of list) {
    if (!e || e.length !== dim) continue;
    for (let i = 0; i < dim; i++) acc[i] += Number(e[i]) || 0;
    n += 1;
  }
  if (!n) return null;
  for (let i = 0; i < dim; i++) acc[i] /= n;
  return l2normalize(acc);
}

/**
 * 用双眼对齐后展开稳定关键点 → 固定维向量
 * @param {Array<{x:number,y:number,z?:number}>} landmarks
 */
export function embeddingFromLandmarks(landmarks) {
  if (!landmarks?.length) return null;
  const p33 = landmarks[33];
  const p263 = landmarks[263];
  if (!p33 || !p263) return null;

  const cx = (p33.x + p263.x) / 2;
  const cy = (p33.y + p263.y) / 2;
  const cz = ((p33.z || 0) + (p263.z || 0)) / 2;
  const dx = p263.x - p33.x;
  const dy = p263.y - p33.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.02) return null;
  const angle = Math.atan2(dy, dx);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);

  const vec = [];
  for (const idx of STABLE_IDX) {
    const p = landmarks[idx];
    if (!p) return null;
    const x = p.x - cx;
    const y = p.y - cy;
    const z = (p.z || 0) - cz;
    vec.push((x * cos - y * sin) / dist);
    vec.push((x * sin + y * cos) / dist);
    vec.push(z / dist);
  }
  if (vec.length !== FACEPRINT_DIM) return null;
  return l2normalize(vec);
}

export function identityLabelZh(result) {
  if (result === 'match') return '认出是你';
  if (result === 'mismatch') return '不太像你';
  if (result === 'uncertain') return '看不太准';
  return '';
}
