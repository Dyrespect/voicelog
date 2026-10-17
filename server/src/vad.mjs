import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * 认人声的门：Silero VAD（sherpa-onnx 跑，模型 600KB，在自己服务器上算、不花钱）。
 * 接口跟 gate.mjs 一样：push(tsMs, pcm, durMs)，只把有人说话的部分（前带 preMs、后带 hangMs）交给 onPass。
 *
 * 为什么（10-16 夜里实测）：gate.mjs 按“比底噪响”判断，屋里太静时门槛跟着降，翻身、呼吸都算有声音，
 * 每次还多带 5 秒——睡觉 3 小时送了 61 分钟去识别，只认出 9 个“嗯”。
 * 先影子跑（VAD_MODE=shadow，默认）：照旧按 gate.mjs 送识别，这边只记账、查会不会漏话；数据没问题再切 VAD_MODE=on。
 */
const SAMPLE_RATE = 16000;
const WINDOW = 512; // Silero 一次吃 512 个采样（32ms）

export const DEFAULT_VAD_MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', 'silero_vad.onnx');

export function createVadDetector({ model = DEFAULT_VAD_MODEL, threshold = 0.5 } = {}) {
  const sherpa = require('sherpa-onnx-node');
  return new sherpa.Vad({
    sileroVad: { model, threshold, minSilenceDuration: 0.25, minSpeechDuration: 0.25, windowSize: WINDOW },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: false,
  }, 30);
}

/** detector：createVadDetector() 的结果（测试里换成假的） */
export function createVadGate({ detector, preMs = 800, hangMs = 800, onPass }) {
  let rest = new Float32Array(0); // 不够一个窗口的尾巴，留到下一帧
  let speaking = false;
  let lastSpeechEnd = -Infinity;
  const pre = [];
  let preDur = 0;

  const feed = (pcm) => {
    const n = pcm.length / 2;
    const all = new Float32Array(rest.length + n);
    all.set(rest);
    for (let i = 0; i < n; i += 1) all[rest.length + i] = pcm.readInt16LE(i * 2) / 32768;
    let off = 0;
    for (; off + WINDOW <= all.length; off += WINDOW) {
      detector.acceptWaveform(all.subarray(off, off + WINDOW));
      speaking = detector.isDetected();
      // 只要“现在是不是人声”，切好的段不用，扔掉免得攒内存
      while (!detector.isEmpty()) detector.pop();
    }
    rest = all.slice(off);
  };

  return {
    push(tsMs, pcm, durMs) {
      feed(pcm);
      if (speaking) {
        lastSpeechEnd = tsMs + durMs;
        for (const f of pre.splice(0)) onPass(f.tsMs, f.pcm, f.durMs);
        preDur = 0;
        onPass(tsMs, pcm, durMs);
        return;
      }
      if (tsMs < lastSpeechEnd + hangMs) {
        onPass(tsMs, pcm, durMs);
        return;
      }
      pre.push({ tsMs, pcm, durMs });
      preDur += durMs;
      while (preDur > preMs && pre.length) preDur -= pre.shift().durMs;
    },
    speaking: () => speaking,
  };
}
