// 假装自己是小智板子：领地址 → 握手（带 boot_ms）→ 推 Opus（协议 v2，时间戳 = 开机毫秒）。
// 用法：DEVICE_MAC=7c:e8:b1:e5:43:14 node test/fake-xiaozhi.mjs <http 基地址，如 http://127.0.0.1:8796/voice> <wav> [--late 3000]
//   --late：先攒着不发，过这么多毫秒再一口气补发（模拟断网后补传），看时间对不对
import fs from 'node:fs';
import OpusScript from 'opusscript';
import WebSocket from 'ws';

const [base, wavPath, ...rest] = process.argv.slice(2);
const enrollMode = rest.includes('--enroll'); // 当成录声纹：先发 enroll，推完发 enroll_end，等结果
const lateIdx = rest.indexOf('--late');
const lateMs = lateIdx >= 0 ? Number(rest[lateIdx + 1]) : 0;
const mac = process.env.DEVICE_MAC || '7c:e8:b1:e5:43:14';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bootAt = Date.now() - 60000; // 假装一分钟前开的机
const bootMs = () => Date.now() - bootAt;

const ota = await fetch(`${base}/xiaozhi/ota/`, { method: 'POST', headers: { 'Device-Id': mac, 'content-type': 'application/json' }, body: '{}' });
if (!ota.ok) { console.error('领地址失败', ota.status); process.exit(1); }
const cfg = await ota.json();
const wsUrl = base.startsWith('http://127.0.0.1') ? `${base.replace('http', 'ws')}/xiaozhi/ws` : cfg.websocket.url;
console.log('领到', cfg.websocket.url, '版本', cfg.websocket.version);

const wav = fs.readFileSync(wavPath);
const pcm = wav.subarray(wav.indexOf('data') + 8);
const enc = new OpusScript(16000, 1, OpusScript.Application.VOIP);
const FRAME = 960 * 2;

const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${cfg.websocket.token}`, 'Protocol-Version': '2', 'Device-Id': mac } });
ws.on('unexpected-response', (_q, r) => { console.error('握手被拒', r.statusCode); process.exit(1); });
ws.on('message', (d, bin) => { if (!bin) console.log('服务端:', String(d).slice(0, 120)); });
ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'hello', version: 2, transport: 'websocket', boot_ms: bootMs(), audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }));
  await sleep(300);
  const startBoot = bootMs();
  if (enrollMode) ws.send(JSON.stringify({ type: 'enroll', name: '我', seconds: 15, start_ms: startBoot, boot_ms: bootMs() }));
  const frames = [];
  for (let off = 0, n = 0; off + FRAME <= pcm.length; off += FRAME, n += 1) {
    const pkt = Buffer.from(enc.encode(pcm.subarray(off, off + FRAME), 960));
    const head = Buffer.alloc(16);
    head.writeUInt16BE(2, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt32BE((startBoot + n * 60) >>> 0, 8);
    head.writeUInt32BE(pkt.length, 12);
    frames.push(Buffer.concat([head, pkt]));
  }
  console.log(`说话开始（真实时间）${new Date(Date.now()).toISOString()}，${frames.length} 帧`);
  if (lateMs) {
    await sleep(lateMs);
    for (const f of frames) ws.send(f);
  } else {
    for (let i = 0; i < frames.length; i += 1) { ws.send(frames[i]); await sleep(60); }
  }
  if (enrollMode) ws.send(JSON.stringify({ type: 'enroll_end', boot_ms: bootMs() }));
  await sleep(6000);
  ws.close();
  console.log('推完了');
});
