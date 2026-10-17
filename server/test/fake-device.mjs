// 假装自己是板子：把一个 16kHz 单声道 16 位的 WAV 按 100ms 一帧、实时速度推给服务端。
// 用法：node test/fake-device.mjs <ws 地址> <wav> [--times 2] [--gap 3000] [--adpcm]
//   --times：推几遍；--gap：每遍之间停多少毫秒（模拟没人说话、板子不发），时间戳照真实时间往后跳
// 令牌从环境变量 DEVICE_TOKEN 读。
import fs from 'node:fs';
import WebSocket from 'ws';
import { encodeFrame } from '../src/adpcm.mjs';

const [url, wavPath, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? Number(rest[i + 1]) : dflt;
};
const times = opt('times', 1);
const gapMs = opt('gap', 3000);
const adpcm = rest.includes('--adpcm');
const state = { predictor: 0, index: 0 };
if (!url || !wavPath || !process.env.DEVICE_TOKEN) {
  console.error('用法：DEVICE_TOKEN=... node test/fake-device.mjs <ws 地址> <wav> [--times 2] [--gap 3000]');
  process.exit(2);
}

const wav = fs.readFileSync(wavPath);
const dataAt = wav.indexOf('data');
const pcm = wav.subarray(dataAt + 8);
const FRAME = 3200; // 100ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
ws.on('unexpected-response', (_req, res) => { console.error(`握手被拒 HTTP ${res.statusCode}`); process.exit(1); });
ws.on('error', (err) => { console.error(err.message); process.exit(1); });
ws.on('open', async () => {
  for (let t = 0; t < times; t += 1) {
    const start = Date.now();
    console.log(`第 ${t + 1} 遍，开始时间 ${new Date(start).toISOString()}`);
    for (let off = 0, n = 0; off < pcm.length; off += FRAME, n += 1) {
      const head = Buffer.alloc(8);
      head.writeBigUInt64LE(BigInt(start + n * 100));
      const chunk = pcm.subarray(off, off + FRAME);
      const body = adpcm && chunk.length === FRAME ? encodeFrame(state, new Int16Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + FRAME))) : chunk;
      ws.send(Buffer.concat([head, body]));
      await sleep(start + (n + 1) * 100 - Date.now());
    }
    if (t < times - 1) await sleep(gapMs);
  }
  // 留时间给识别服务出最后一句
  await sleep(4000);
  ws.close();
  console.log('推完了');
});
