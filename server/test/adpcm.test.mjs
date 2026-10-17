// ADPCM 编解码来回一遍，声音不能走样太多（不花钱）
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, encodeFrame } from '../src/adpcm.mjs';

test('ADPCM 来回：信噪比 > 15dB，长度对得上', () => {
  // 两个频率叠加 + 起伏，近似说话
  const n = 16000;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / 16000);
    pcm[i] = Math.round(env * (6000 * Math.sin((2 * Math.PI * 220 * i) / 16000) + 3000 * Math.sin((2 * Math.PI * 1300 * i) / 16000)));
  }
  const state = { predictor: 0, index: 0 };
  let sig = 0;
  let err = 0;
  for (let off = 0; off < n; off += 1600) {
    const frame = encodeFrame(state, pcm.subarray(off, off + 1600));
    assert.equal(frame.length, 804);
    const out = decodeFrame(frame);
    assert.equal(out.length, 3200);
    for (let i = 0; i < 1600; i += 1) {
      const d = out.readInt16LE(i * 2) - pcm[off + i];
      sig += pcm[off + i] ** 2;
      err += d * d;
    }
  }
  const snr = 10 * Math.log10(sig / err);
  assert.ok(snr > 15, `信噪比只有 ${snr.toFixed(1)}dB`);
});
