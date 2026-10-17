/**
 * IMA ADPCM 解码（板子 firmware/src/adpcm.h 的另一半，表和算法必须一模一样）。
 * 一帧 = 4 字节头（predictor 小端 int16、index、0）+ 每字节两个采样（先低 4 位后高 4 位）。
 * encodeFrame 只给测试用。
 */
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
  107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
  5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
  27086, 29794, 32767,
];

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
const clampIndex = (i) => (i < 0 ? 0 : i > 88 ? 88 : i);

/** ADPCM 帧 → 16 位小端 PCM */
export function decodeFrame(frame) {
  let pred = frame.readInt16LE(0);
  let index = clampIndex(frame[2]);
  const out = Buffer.alloc((frame.length - 4) * 4);
  let o = 0;
  const step1 = (code) => {
    const step = STEP[index];
    let vpdiff = step >> 3;
    if (code & 4) vpdiff += step;
    if (code & 2) vpdiff += step >> 1;
    if (code & 1) vpdiff += step >> 2;
    pred = clamp16(code & 8 ? pred - vpdiff : pred + vpdiff);
    index = clampIndex(index + INDEX[code]);
    out.writeInt16LE(pred, o);
    o += 2;
  };
  for (let i = 4; i < frame.length; i += 1) {
    step1(frame[i] & 0x0f);
    step1(frame[i] >> 4);
  }
  return out;
}

/** 测试用：16 位 PCM（Int16Array）→ ADPCM 帧，state 跨帧带着走 */
export function encodeFrame(state, pcm) {
  const out = Buffer.alloc(4 + pcm.length / 2);
  out.writeInt16LE(state.predictor, 0);
  out[2] = state.index;
  const enc = (sample) => {
    let diff = sample - state.predictor;
    let code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let step = STEP[state.index];
    let vpdiff = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; vpdiff += step; }
    step >>= 1;
    if (diff >= step) { code |= 2; diff -= step; vpdiff += step; }
    step >>= 1;
    if (diff >= step) { code |= 1; vpdiff += step; }
    state.predictor = clamp16(code & 8 ? state.predictor - vpdiff : state.predictor + vpdiff);
    state.index = clampIndex(state.index + INDEX[code]);
    return code;
  };
  for (let i = 0; i < pcm.length; i += 2) out[4 + i / 2] = enc(pcm[i]) | (enc(pcm[i + 1]) << 4);
  return out;
}
