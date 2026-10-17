import { randomUUID } from 'node:crypto';
import OpusScript from 'opusscript';

/**
 * 小智固件（xiaozhi-esp32，我们的分支在 ../device）的服务端协议，照 device/docs/websocket.md：
 * - 开机先 POST /xiaozhi/ota/ 拿 WebSocket 地址和令牌（只给登记过的板子，看 Device-Id 头里的 MAC）。
 * - WebSocket：板子发 hello（我们的分支多带 boot_ms = 板子开机以来的毫秒），服务端回 hello；
 *   之后二进制帧是 Opus（16kHz 单声道 60ms 一帧）。协议 v2 的 timestamp 字段我们的分支放的是“采集时的开机毫秒”，
 *   服务端用 hello 时记下的差值换成真实时间——断网时攒着、连上补传的帧时间也是对的，不靠板子自己的时钟。
 * - 文字帧：listen（不用管）、status（板子定时报的状态）。
 * - 服务端每 30 秒发一条 {"type":"voicelog"}：小智 120 秒收不到服务端任何消息就当通道断了（protocol.cc IsTimeout）。
 */
/**
 * firmware：服务器上有更新的固件（firmware/latest.json：{"version":"2.6.2","file":"voicelog-2.6.2.bin"}）就告诉板子；
 * 板子比一比版本号，新的就自己下载、升级、重启（小智自带；新固件连不上服务器会自动退回旧的）。
 */
/** 板子型号：User-Agent “voicelog-zhengchen-1.54/2.8.0” → “voicelog-zhengchen-1.54”（老 StickS3 固件连 ws 时不带，算 StickS3） */
export function boardOf(userAgent) {
  const b = String(userAgent || '').split('/')[0].trim().toLowerCase();
  return /^[a-z][a-z0-9.-]*$/.test(b) ? b : 'voicelog-stick-s3';
}

/** 记录里板子的名字：型号前缀 + MAC 后 4 位（StickS3 一直叫 stick-xxxx，正辰 1.54 叫 zc-xxxx） */
export function deviceName(userAgent, mac) {
  const tail = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase().slice(-4) || 'xz';
  return `${boardOf(userAgent).includes('zhengchen') ? 'zc' : 'stick'}-${tail}`;
}

export function otaResponse({ wsUrl, token, firmware = null, now = Date.now() }) {
  return {
    server_time: { timestamp: now, timezone_offset: 480 },
    firmware: firmware ?? { version: '0.0.0', url: '' },
    websocket: { url: wsUrl, token, version: 2 },
  };
}

/** 板子 hello 里的 audio_params 我们只认 16kHz Opus 单声道 */
const SERVER_HELLO = (sessionId) => ({
  type: 'hello',
  transport: 'websocket',
  session_id: sessionId,
  audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 },
});

/**
 * 解析一个二进制帧。v1：整帧就是 Opus；v2：16 字节头（version、type、reserved、timestamp、payload_size，网络字节序）；
 * v3：4 字节头（type、reserved、payload_size）。返回 { type, timestamp|null, payload } 或 null。
 */
export function parseFrame(buf, version) {
  if (version === 2) {
    if (buf.length < 16) return null;
    const size = buf.readUInt32BE(12);
    if (16 + size > buf.length) return null;
    return { type: buf.readUInt16BE(2), timestamp: buf.readUInt32BE(8), payload: buf.subarray(16, 16 + size) };
  }
  if (version === 3) {
    if (buf.length < 4) return null;
    const size = buf.readUInt16BE(2);
    return { type: buf[0], timestamp: null, payload: buf.subarray(4, 4 + size) };
  }
  return { type: 0, timestamp: null, payload: buf };
}

/**
 * 接一台小智板子。onAudio(tsMs, pcm, durMs) 收解出来的 16kHz PCM；onStatus(obj) 收状态。
 */
export function attachXiaozhi(ws, req, { onAudio, onStatus, onSnapshot = () => {}, todayStats = () => ({}), log = console }) {
  const version = Number(req.headers['protocol-version'] || 1);
  const decoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  // 真实时间 = 开机毫秒 + offset；offset 只会因为网络延迟偏大，所以每次拿到新的取小的
  let offset = null;
  const learnClock = (bootMs) => {
    if (typeof bootMs !== 'number' || !Number.isFinite(bootMs)) return;
    const o = Date.now() - bootMs;
    offset = offset === null ? o : Math.min(offset, o);
  };
  let frames = 0;
  // 保活顺带把今天的数发给板子屏幕：几段、几句、上一段的时间和标题
  const sendStats = () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'voicelog', frames, ...todayStats() }));
  };
  const keepalive = setInterval(sendStats, 30000);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === 'hello') {
        learnClock(msg.boot_ms);
        ws.send(JSON.stringify(SERVER_HELLO(randomUUID())));
        setTimeout(sendStats, 1500);
      } else if (msg.type === 'status' || msg.type === 'enroll' || msg.type === 'enroll_end' || msg.type === 'enroll_cancel' || msg.type === 'people') {
        learnClock(msg.boot_ms);
        onStatus(msg);
      } else if (msg.type === 'snapshot') {
        if (typeof msg.jpeg === 'string') onSnapshot(Buffer.from(msg.jpeg, 'base64'));
        else log.error(`[snapshot] 板子截屏失败：${msg.error || '没说原因'}`);
      }
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
    const f = parseFrame(buf, version);
    if (!f || f.type !== 0 || !f.payload.length) return;
    let pcm;
    try {
      pcm = Buffer.from(decoder.decode(f.payload));
    } catch (err) {
      log.error(`[xiaozhi] Opus 解不开：${err.message}`);
      return;
    }
    const durMs = (pcm.length / 2 / 16000) * 1000;
    // 有开机毫秒和差值就用它；老的小智固件没有，就按收到的时间往前推一帧
    const tsMs = f.timestamp !== null && offset !== null ? offset + f.timestamp : Date.now() - durMs;
    frames += 1;
    onAudio(tsMs, pcm, durMs);
  });

  ws.on('close', () => {
    clearInterval(keepalive);
    try { decoder.delete(); } catch { /* 已经释放了 */ }
  });

  /** 让板子截一张屏传回来（调界面用） */
  const requestSnapshot = () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'voicelog', snapshot: true }));
  };
  /** 板子的开机毫秒 → 真实时间（录声纹的时间窗用） */
  const toEpoch = (bootMs) => (offset === null || typeof bootMs !== 'number' ? Date.now() : offset + bootMs);
  /** 发一条 JSON 给板子 */
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'voicelog', ...obj })); };
  return { frames: () => frames, version, requestSnapshot, toEpoch, send };
}
