// 认人声的门（假检测器，不加载模型）：前带、后带、静音不放
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVadGate } from '../src/vad.mjs';

// 假检测器：喂进来的样本绝对值大于 0.1 就算“在说话”
function fakeDetector() {
  let on = false;
  return {
    acceptWaveform(w) { on = w.some((x) => Math.abs(x) > 0.1); },
    isDetected: () => on,
    isEmpty: () => true,
    pop() {},
  };
}
const frame = (loud) => { const b = Buffer.alloc(960 * 2); if (loud) for (let i = 0; i < 960; i += 1) b.writeInt16LE(8000, i * 2); return b; };

test('只放有人声的部分，前带 0.8 秒、后带 0.8 秒', () => {
  const passed = [];
  const g = createVadGate({ detector: fakeDetector(), onPass: (ts) => passed.push(ts) });
  let ts = 0;
  for (let i = 0; i < 20; i += 1) { g.push(ts, frame(false), 60); ts += 60; } // 1.2 秒安静
  assert.equal(passed.length, 0);
  for (let i = 0; i < 10; i += 1) { g.push(ts, frame(true), 60); ts += 60; } // 0.6 秒说话
  for (let i = 0; i < 30; i += 1) { g.push(ts, frame(false), 60); ts += 60; } // 1.8 秒安静
  const pre = passed.filter((t) => t < 1200).length;
  const hang = passed.filter((t) => t >= 1800).length;
  assert.ok(pre >= 12 && pre <= 14, `前带 ${pre} 帧`);
  assert.ok(hang >= 12 && hang <= 15, `后带 ${hang} 帧`);
  assert.equal(passed.length, pre + 10 + hang);
});

test('一直安静：一帧都不放', () => {
  const passed = [];
  const g = createVadGate({ detector: fakeDetector(), onPass: (ts) => passed.push(ts) });
  for (let i = 0; i < 200; i += 1) g.push(i * 60, frame(false), 60);
  assert.equal(passed.length, 0);
});
