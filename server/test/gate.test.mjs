// 服务端判断有没有人说话 + 小智帧解析（不花钱）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../src/gate.mjs';
import { parseFrame } from '../src/xiaozhi.mjs';

const frame = (amp) => {
  const b = Buffer.alloc(960 * 2);
  for (let i = 0; i < 960; i += 1) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2);
  return b;
};

test('安静不放行；开口放行并补上前 1 秒；说完再带 5 秒', () => {
  const passed = [];
  const gate = createGate({ onPass: (ts) => passed.push(ts) });
  let ts = 0;
  for (let i = 0; i < 100; i += 1, ts += 60) gate.push(ts, frame(300), 60); // 6 秒安静，底噪跟到 ~212
  assert.equal(passed.length, 0);
  gate.push(ts, frame(6000), 60); // 开口
  const preRoll = passed.length - 1;
  assert.ok(preRoll >= 15 && preRoll <= 18, `前面补了 ${preRoll} 帧`);
  assert.equal(passed[passed.length - 1], ts);
  passed.length = 0;
  ts += 60;
  for (let i = 0; i < 150; i += 1, ts += 60) gate.push(ts, frame(300), 60); // 说完 9 秒安静
  assert.ok(passed.length >= 82 && passed.length <= 85, `说完带了 ${passed.length} 帧`);
});

test('小智协议 v2 帧：网络字节序的头 + Opus', () => {
  const payload = Buffer.from([1, 2, 3]);
  const buf = Buffer.alloc(16 + 3);
  buf.writeUInt16BE(2, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(0, 4);
  buf.writeUInt32BE(123456, 8);
  buf.writeUInt32BE(3, 12);
  payload.copy(buf, 16);
  const f = parseFrame(buf, 2);
  assert.equal(f.type, 0);
  assert.equal(f.timestamp, 123456);
  assert.deepEqual([...f.payload], [1, 2, 3]);
  assert.equal(parseFrame(Buffer.alloc(10), 2), null);
});
