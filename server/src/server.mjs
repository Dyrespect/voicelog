import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { decodeFrame } from './adpcm.mjs';
import { openAsr } from './asr.mjs';
import { createCos } from './cos.mjs';
import { createConvs, createTitler } from './convs.mjs';
import { createDayLog, createDayStats, beijingDate, beijingIso } from './daylog.mjs';
import { createGate, rmsOf } from './gate.mjs';
import { DEFAULT_VAD_MODEL, createVadDetector, createVadGate } from './vad.mjs';
import { openPrintStore } from './printsStore.mjs';
import { DEFAULT_MODEL, DEFAULT_SEGMENTATION_MODEL, ENROLLED_SIM, SESSION_GAP_MS, cleanName, createDiarizer, createEmbedder, createSpeakerBook, guessName, loadPrints, mean, peoplePayload, savePrints, splitBySpeaker, shortWho } from './speakers.mjs';
import { createTranscriber } from './transcriber.mjs';
import { attachXiaozhi, boardOf, deviceName, otaResponse } from './xiaozhi.mjs';

/**
 * 随身录音的服务端：板子推声音进来，转给百炼实时识别，定稿的句子带上时间写进 COS。
 * 声音只在内存里过一下，不落盘、不存 COS。句子再按 5 分钟的空档分成对话，每段起个小标题（convs.mjs）。
 *
 * 两种板子固件：
 * - 小智分支（device/，2026-10-15 起）：/xiaozhi/ota/ 领地址 → /xiaozhi/ws 推 Opus，一直发，服务端判断有没有人说话（gate.mjs）。
 * - 老固件（firmware/，Arduino）：/stream，下面这种帧，板子自己挑有人说话的才发。
 *
 * 老固件发的每个二进制帧：前 8 字节 = 这段声音第一个采样的时间（毫秒，Unix 时间，小端 uint64），
 * 后面是 100ms 的声音：3200 字节 = 16kHz 单声道 16 位 PCM（老固件）；其他长度 = IMA ADPCM 帧（adpcm.mjs，
 * 2026-10-15 起，体积 1/4）。文字帧是板子每 30 秒报一次的状态（电量、信号、攒着没发的秒数……）。板子只在有人说话时发（前后各留一段），所以帧之间会有空档。
 * 空档一出现就结束当前识别任务、按新时间开一个，这样每句的时间 = 任务开头时间 + 句子在任务里的位置。
 */
const env = process.env;
const need = (name) => {
  if (!env[name]) throw new Error(`缺少环境变量 ${name}`);
  return env[name];
};

const PORT = Number(env.PORT || 8796);
const HOST = env.HOST || '127.0.0.1';
const BASE = env.BASE_PATH || '/voice';
const DEVICE_TOKEN = need('DEVICE_TOKEN');
const ASR_MODEL = env.ASR_MODEL || 'paraformer-realtime-v2';
/** 热词表（hotwords.txt），没配就不用 */
const ASR_VOCABULARY_ID = env.ASR_VOCABULARY_ID || '';
const DASHSCOPE_API_KEY = need('DASHSCOPE_API_KEY');
/** 对外的 WebSocket 地址（发给小智板子） */
const PUBLIC_WS = env.PUBLIC_WS || 'wss://example.com/voice/xiaozhi/ws';
/** 远程升级用的固件放这里（latest-<型号>.json + .bin，按板子型号分开），deploy/release-firmware.sh 往里放 */
const FIRMWARE_DIR = env.FIRMWARE_DIR || '/opt/voicelog/firmware';
const PUBLIC_BASE = env.PUBLIC_BASE || 'https://example.com/voice';

function latestFirmware(board) {
  try {
    // 按型号找；StickS3 以前只有一个 latest.json，没有就退回它（别的型号不退，免得刷错板子）
    let file = path.join(FIRMWARE_DIR, `latest-${board}.json`);
    if (!fs.existsSync(file) && board === 'voicelog-stick-s3') file = path.join(FIRMWARE_DIR, 'latest.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m.version || !/^[\w.-]+\.bin$/.test(m.file || '')) return null;
    return { version: m.version, url: `${PUBLIC_BASE}/xiaozhi/firmware/${m.file}` };
  } catch {
    return null;
  }
}

/** 登记过的小智板子（MAC，逗号分隔）：只有它们能从 /xiaozhi/ota/ 领到令牌 */
const XIAOZHI_DEVICES = (env.XIAOZHI_DEVICES || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

const cos = createCos({
  secretId: need('COS_SECRET_ID'),
  secretKey: need('COS_SECRET_KEY'),
  bucket: need('COS_BUCKET'),
  region: need('COS_REGION'),
});
const PREFIX = env.VOICELOG_PREFIX || 'voicelog/';
const FLUSH_MS = Number(env.FLUSH_MS || 10000);
const daylog = createDayLog({ cos, prefix: PREFIX, flushMs: FLUSH_MS });
const dayStats = createDayStats({ cos, prefix: PREFIX, flushMs: FLUSH_MS });
const convs = createConvs({
  cos,
  prefix: PREFIX,
  flushMs: FLUSH_MS,
  titler: createTitler({ apiKey: DASHSCOPE_API_KEY, model: env.TITLE_MODEL || 'qwen-flash' }),
});
setInterval(() => convs.tick(), 30000).unref();

const status = { devices: new Map(), started: Date.now() };
/** 每台板子上次记状态的时间（跨连接） */
const statusLog = new Map();
/** 每台板子的环境底噪，下一段连接接着用（见 gate.mjs） */
const floors = new Map();

// 区分说话人（speakers.mjs）：模型没装就不分，照常转写
let embed = null;
let diarize = null;
try {
  embed = createEmbedder(env.SPEAKER_MODEL || DEFAULT_MODEL);
} catch (err) {
  console.error(`[spk] 声纹模型没加载，不区分说话人：${err.message}`);
}
try {
  if (embed) diarize = createDiarizer({ segmentationModel: env.SEGMENTATION_MODEL || DEFAULT_SEGMENTATION_MODEL, embeddingModel: env.SPEAKER_MODEL || DEFAULT_MODEL });
} catch (err) {
  console.error(`[spk] 分段模型没加载，长句子不按人切：${err.message}`);
}
const SPEAKER_THRESHOLD = Number(env.SPEAKER_THRESHOLD || 0.6);
/**
 * 送不送去识别，谁说了算（vad.mjs）：shadow = 照旧按“比底噪响”送，认人声的新门只记账、查会不会漏话（默认）；
 * on = 新门说了算；off = 不跑新门。10-17 起影子跑，数据没问题再切 on。
 */
const VAD_MODE = ['shadow', 'on', 'off'].includes(env.VAD_MODE) ? env.VAD_MODE : 'shadow';
const VAD_MODEL = env.VAD_MODEL || DEFAULT_VAD_MODEL;
const VOICEPRINTS_KEY = `${PREFIX}voiceprints.json`;
const PRINTS_DB = env.VOICELOG_DB || '/var/lib/voicelog/voiceprints.db';
/** 登记过的声纹 {id: {v: Float32Array, name}}。一个人一行，在 PRINTS_DB。没登记的人不进这里。 */
const printStore = openPrintStore(PRINTS_DB);
let voiceprints = printStore.read();
let printWrite = Promise.resolve();
function logPrints(why) {
  const shown = Object.entries(voiceprints).map(([id, p]) => (p.name && p.name !== id ? `${id}（${p.name}）` : id));
  console.log(`[spk] ${why}：${shown.join('、') || '无'}`);
}
const speakerBooks = new Map(); // `${device}|${date}` -> book
function speakerBook(device, date) {
  const key = `${device}|${date}`;
  if (!speakerBooks.has(key)) {
    for (const k of speakerBooks.keys()) if (k.startsWith(`${device}|`)) speakerBooks.delete(k); // 换天就重新编号
    speakerBooks.set(key, createSpeakerBook({
      embed,
      enrolled: () => Object.fromEntries(Object.entries(voiceprints).map(([id, p]) => [id, p.v])),
      threshold: SPEAKER_THRESHOLD,
      enrolledThreshold: ENROLLED_SIM,
      sessionGapMs: SESSION_GAP_MS,
      log: (line) => console.log(`[spk] ${device} ${line}`),
    }));
  }
  return speakerBooks.get(key);
}

const NAME_SYSTEM = `下面是一段声纹登记时说的话，可能有识别错的字。请抽出这个人的姓名。
规则：
- “我是戴敬力，戴帽子的戴” → 戴敬力。后面那句是在解释哪个字。
- “我叫小红，红是红色的红” → 小红。
- 只要姓名，2到4个汉字。不要“我是”，不要头衔。话里没出现的人不要编。
- 没说出姓名就留空。
只输出 JSON：{"name":"戴敬力"} 或 {"name":""}`;

/** 15 秒登记的 PCM 转成字。失败就空字符串，不往上抛。 */
function transcribeEnroll(pcm) {
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(text.trim());
    };
    const asr = openAsr({
      apiKey: DASHSCOPE_API_KEY,
      model: ASR_MODEL,
      sampleRate: 16000,
      vocabularyId: ASR_VOCABULARY_ID,
    }, {
      onSentence: (s) => { text += s.text; },
      onError: (detail) => console.error(`[spk] 登记转写失败：${detail}`),
      onDone: done,
    });
    const chunk = 3200;
    for (let i = 0; i < pcm.length; i += chunk) asr.send(pcm.subarray(i, Math.min(pcm.length, i + chunk)));
    asr.finish();
    setTimeout(done, 12000).unref();
  });
}

async function nameFromSpeech(text) {
  const local = guessName(text);
  if (!text) return local;
  try {
    const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DASHSCOPE_API_KEY}` },
      body: JSON.stringify({
        model: env.TITLE_MODEL || 'qwen-flash',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: NAME_SYSTEM }, { role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const out = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return cleanName(out.name) || local;
  } catch (err) {
    console.error(`[spk] 听名字失败：${err.message}`);
    return local;
  }
}
/** 小智板子的连接（截屏要找到它） */
const xiaozhiLinks = new Map();

function tokenOk(req, url) {
  const auth = req.headers.authorization || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(DEVICE_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 一台板子一条连接：状态、转写、日志。live(text, final) 把刚识别出来的字推回板子屏幕；
 * attribute(句子) 认这句是谁说的，一句里有几个人就切成几行（[{startMs, endMs, text, speaker}]）
 */
function startSession(ws, device, live = () => {}, attribute = (s) => [s]) {
  const st = { device, connectedAt: Date.now(), lastFrameAt: 0, frames: 0, sentences: 0, lastText: '', errors: 0 };
  status.devices.set(device, st);
  const tr = createTranscriber({
    apiKey: DASHSCOPE_API_KEY,
    model: ASR_MODEL,
    vocabularyId: ASR_VOCABULARY_ID,
    onSentence: (sentence) => {
      st.sentences += 1;
      st.lastText = sentence.text;
      let parts = [sentence];
      try { parts = attribute(sentence); } catch (err) { console.error(`[spk] ${err.message}`); }
      for (const p of parts) {
        const line = { startMs: p.startMs, endMs: p.endMs, text: p.text, device };
        if (p.speaker) line.speaker = p.speaker;
        if (p.speaker && voiceprints[p.speaker]?.name) line.name = voiceprints[p.speaker].name;
        daylog.add(line);
        convs.add(line);
      }
      // 板子屏幕上每句前面标是谁说的（“我”“二号”）：一句切成几个人就分几段推
      if (parts.length > 1) parts.forEach((p) => live(p.text, true, p.speaker));
      else live(sentence.text, true, parts[0]?.speaker);
    },
    onPartial: (text) => live(text, false),
    onError: (detail) => {
      st.errors += 1;
      console.error(`[asr] ${device} ${detail}`);
    },
  });

  // 板子的状态：放进 /health；每 5 分钟、或者丢了声音 / 重连过网络时记一行日志
  const onStatus = (s) => {
    st.status = { ...s, at: beijingIso(Date.now()) };
    // 每台板子 5 分钟记一条（跨连接：熄屏时板子 30 秒连一次），丢了声音、重连了马上记；量续航看 vbat
    const now = Date.now();
    const last = statusLog.get(device) || { at: 0, dropped: 0, netResets: 0 };
    if (now - last.at > 5 * 60000 || (s.droppedSec ?? 0) > last.dropped || (s.netResets ?? 0) > last.netResets) {
      statusLog.set(device, { at: now, dropped: s.droppedSec ?? 0, netResets: s.netResets ?? 0 });
      console.log(`[status] ${device} ${JSON.stringify(s)}`);
    }
  };

  const onFrame = (tsMs) => {
    st.frames += 1;
    st.lastFrameAt = Date.now();
    st.lastAudioAt = tsMs;
  };

  console.log(`[ws] ${device} 连上`);
  ws.on('close', (code, reason) => {
    tr.close();
    st.disconnectedAt = Date.now();
    const secs = Math.round((st.disconnectedAt - st.connectedAt) / 1000);
    console.log(`[ws] ${device} 断了：code=${code} ${String(reason || '')} 连了 ${secs} 秒，收到 ${st.frames} 帧${ws.killedByPing ? '（30 秒没回 pong，服务端断的）' : ''}`);
  });
  ws.on('error', (err) => console.error(`[ws] ${device} ${err.message}`));
  return { st, tr, onStatus, onFrame };
}

/** 老固件（firmware/）：帧 = 8 字节 Unix 毫秒 + PCM / ADPCM；板子自己挑过有人说话的 */
function legacySession(ws, device) {
  const { tr, onStatus, onFrame } = startSession(ws, device);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try { onStatus(JSON.parse(String(data))); } catch { /* 不是 JSON 不管 */ }
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
    if (buf.length < 14) return;
    const ts = Number(buf.readBigUInt64LE(0));
    const body = buf.subarray(8);
    const pcm = body.length === 3200 ? body : decodeFrame(body);
    onFrame(ts);
    tr.push(ts, pcm);
  });
}

/** 小智分支（device/）：一直发 Opus，服务端判断有没有人说话再交给识别 */
function xiaozhiSession(ws, req, device) {
  // 刚识别出来的字推给板子屏幕（戴敬力 10-15：“能不能在小的 StickS3 上面也呈现出来，有个反馈”）；没说完的最多一秒两次
  let lastPartialAt = 0;
  const live = (text, final, speaker) => {
    const now = Date.now();
    if (!final && now - lastPartialAt < 500) return;
    lastPartialAt = now;
    if (ws.readyState === ws.OPEN) {
      const extra = final ? { recordedSec: Math.round(dayStats.recordedMs(beijingDate(now), device) / 1000) } : {};
      const who = shortWho(speaker);
      if (who) extra.who = who;
      ws.send(JSON.stringify({ type: 'voicelog', live: text, final, at: beijingIso(now).slice(11, 19), ...extra }));
    }
  };
  // 最近 3 分钟送去识别的声音（只在内存里），句子定稿后按时间切出来认是谁
  const recent = [];
  // 新门（认人声）影子跑：记下它会放的帧，识别出来的句子它要是大半没放，就记一笔“会漏”
  const vadFrames = new Set();
  const vadOrder = [];
  const checkVadMiss = (sentence, frames) => {
    if (VAD_MODE !== 'shadow' || !vadGate || !frames.length) return;
    const hit = frames.filter((f) => vadFrames.has(f.tsMs)).length;
    if (hit / frames.length >= 0.5) return;
    dayStats.addVadMiss(device, sentence.startMs);
    console.log(`[vad] ${device} 新门会漏（${hit}/${frames.length} 帧）：${sentence.text}`);
  };
  const attribute = (sentence) => {
    const frames = recent.filter((f) => f.tsMs + f.durMs > sentence.startMs - 100 && f.tsMs < sentence.endMs + 100);
    checkVadMiss(sentence, frames);
    if (!embed || !frames.length) return [sentence];
    const t0 = Date.now();
    const parts = splitBySpeaker({
      sentence,
      pcm: Buffer.concat(frames.map((f) => f.pcm)),
      pcmStartMs: frames[0].tsMs,
      book: speakerBook(device, beijingDate(sentence.startMs)),
      diarize,
    });
    if (parts.length > 1) console.log(`[spk] ${device} 一句切成 ${parts.length} 行（${Date.now() - t0}ms）：${parts.map((p) => p.speaker).join(' / ')}`);
    return parts;
  };
  // 录声纹是单独的一件事：板子在声纹页选中一个人 → 发 enroll（name 是“我”、已有的 id，或空=新增）
  // → 这 15 秒只拿来算声纹，不进对话 → enroll_end 之后转写一句，听出名字再存。
  // 选“我”时，说“我是戴敬力”只是把名字记在“我”上，不会把主人换成别人。
  let enrolling = null; // { slot, startMs, endMs, pcm[], timer }
  let xz = null;
  const finishEnroll = async () => {
    const e = enrolling;
    enrolling = null;
    if (!e) return;
    clearTimeout(e.timer);
    const fail = (reason) => {
      xz?.send({ enroll: 'fail', reason, people: peoplePayload(voiceprints) });
      console.log(`[spk] ${device} 记“${e.slot || '新的人'}”没成：${reason}`);
    };
    const all = e.pcm.length ? Buffer.concat(e.pcm) : Buffer.alloc(0);
    if (!embed || all.length < 3 * 32000) {
      fail(all.length < 3 * 32000 ? '没听清' : '没有声纹模型');
      return;
    }
    // 切成 3 秒一段分别算再取平均（不够两段就整段算）
    const vectors = [];
    if (all.length < 6 * 32000) vectors.push(embed(all));
    else for (let off = 0; off + 96000 <= all.length; off += 96000) vectors.push(embed(all.subarray(off, off + 96000)));
    const vector = mean(vectors);
    const remember = (id, display) => {
      const job = printWrite.then(async () => {
        const next = { ...voiceprints, [id]: { v: vector, name: display || '' } };
        printStore.writeAll(next);
        voiceprints = next;
        try {
          await cos.putText(VOICEPRINTS_KEY, JSON.stringify(savePrints(voiceprints)), 'application/json');
        } catch (err) {
          console.error(`[spk] 声纹备份到 COS 失败（库里已经有了）：${err.message}`);
        }
      });
      printWrite = job.catch(() => {});
      return job;
    };
    const tell = (id, display) => {
      const who = display && display !== id ? `${id}（${display}）` : id;
      console.log(`[spk] ${device} 记住了“${who}”（${(all.length / 32000).toFixed(1)} 秒人声）`);
      xz?.send({ enroll: 'ok', id, name: display || '', people: peoplePayload(voiceprints) });
    };
    const hearName = async () => {
      const text = await transcribeEnroll(all);
      console.log(`[spk] ${device} 登记时说：${text || '（空）'}`);
      return guessName(text) || await nameFromSpeech(text);
    };
    // 已经有这个人（包括「我」）：声纹先存上，马上回板子。名字慢慢听，听出来再补。
    if (e.slot) {
      if (e.slot !== '我' && !voiceprints[e.slot]) { fail('没有这个人'); return; }
      const id = e.slot === '我' ? '我' : e.slot;
      const display = voiceprints[id]?.name || (id === '我' ? '' : id);
      try { await remember(id, display); } catch (err) {
        console.error(`[spk] 存声纹失败：${err.message}`);
        fail('没存上');
        return;
      }
      tell(id, display);
      hearName().then(async (heard) => {
        if (!heard || heard === (voiceprints[id]?.name || '')) return;
        await remember(id, heard);
        tell(id, heard);
      }).catch((err) => console.error(`[spk] ${device} 听名字出错：${err.message}`));
      return;
    }
    // 「新增」还没有名字，得先听出来才能建这个人
    let heard = '';
    try { heard = await hearName(); } catch (err) {
      console.error(`[spk] ${device} 听名字出错：${err.message}`);
    }
    if (!heard || heard === '新增' || heard === '其他人' || heard.startsWith('说话人')) { fail('没听清名字'); return; }
    try { await remember(heard, heard); } catch (err) {
      console.error(`[spk] 存声纹失败：${err.message}`);
      fail('没存上');
      return;
    }
    tell(heard, heard);
  };
  const startEnroll = (slot = '我', startMs = Date.now(), seconds = 15) => {
    if (!embed) return false;
    if (enrolling) clearTimeout(enrolling.timer);
    // 板子 15 秒后会发 enroll_end；万一没收到，25 秒后自己收尾
    enrolling = { slot: String(slot), startMs, endMs: startMs + seconds * 1000, pcm: [], timer: setTimeout(() => { finishEnroll(); }, (seconds + 10) * 1000) };
    console.log(`[spk] ${device} 开始记“${slot || '新的人'}”的声纹`);
    return true;
  };
  const cancelEnroll = () => {
    if (!enrolling) return;
    clearTimeout(enrolling.timer);
    enrolling = null;
    console.log(`[spk] ${device} 取消登记`);
  };
  /** 这一帧在录声纹的时间窗里：只收有声音的帧（太静的拉低声纹质量），不往下走 */
  const takeForEnroll = (tsMs, pcm) => {
    if (!enrolling || tsMs < enrolling.startMs || tsMs > enrolling.endMs) return false;
    if (rmsOf(pcm) > 200) enrolling.pcm.push(pcm);
    return true;
  };
  const session = startSession(ws, device, live, attribute);
  session.st.startEnroll = startEnroll;
  const toAsr = (tsMs, pcm, durMs) => {
    dayStats.addAsr(device, tsMs, durMs);
    recent.push({ tsMs, pcm, durMs });
    while (recent.length && recent[recent.length - 1].tsMs - recent[0].tsMs > 180000) recent.shift();
    session.tr.push(tsMs, pcm);
  };
  let vadGate = null;
  if (VAD_MODE !== 'off') {
    try {
      vadGate = createVadGate({
        detector: createVadDetector({ model: VAD_MODEL }),
        onPass: (tsMs, pcm, durMs) => {
          dayStats.addVad(device, tsMs, durMs);
          if (VAD_MODE === 'on') { toAsr(tsMs, pcm, durMs); return; }
          vadFrames.add(tsMs);
          vadOrder.push(tsMs);
          while (vadOrder.length && vadOrder[0] < tsMs - 180000) vadFrames.delete(vadOrder.shift());
        },
      });
    } catch (err) {
      console.error(`[vad] 认人声的模型没加载，照旧按底噪判断：${err.message}`);
    }
  }
  const useVad = VAD_MODE === 'on' && vadGate;
  const gate = createGate({ floor: floors.get(device), onPass: useVad ? () => {} : toAsr });
  session.st.gate = gate;
  xz = attachXiaozhi(ws, req, {
    onAudio: (tsMs, pcm, durMs) => {
      session.onFrame(tsMs);
      if (takeForEnroll(tsMs, pcm)) return;
      dayStats.add(device, tsMs, durMs);
      gate.push(tsMs, pcm, durMs);
      if (vadGate) {
        try { vadGate.push(tsMs, pcm, durMs); } catch (err) {
          // 新门出错不能耽误录音：关掉它，照旧按底噪判断
          console.error(`[vad] ${device} 出错，这条连接不再用新门：${err.message}`);
          vadGate = null;
        }
      }
    },
    onStatus: (s) => {
      if (s.type === 'enroll') {
        // 老固件不带 name 时算“我”；空字符串是声纹页的「新增」
        const slot = Object.prototype.hasOwnProperty.call(s, 'name') ? String(s.name ?? '') : '我';
        startEnroll(slot, xz.toEpoch(s.start_ms ?? s.boot_ms), Number(s.seconds) || 15);
      }
      // 板子说时间到了：再等 1.5 秒让最后几帧到，再算
      else if (s.type === 'enroll_end') setTimeout(() => { finishEnroll(); }, 1500);
      else if (s.type === 'enroll_cancel') cancelEnroll();
      else if (s.type === 'people') xz?.send({ people: peoplePayload(voiceprints) });
      else session.onStatus(s);
    },
    onSnapshot: (jpeg) => {
      session.st.snapshot = { at: beijingIso(Date.now()), jpeg };
      console.log(`[snapshot] ${device} ${jpeg.length} 字节`);
    },
    todayStats: () => {
      const today = beijingDate(Date.now());
      // 戴敬力 10-15：只关心今天录了多久、刚才说了什么；几段、几句、标题不上屏
      return { recordedSec: Math.round(dayStats.recordedMs(today, device) / 1000) };
    },
  });
  session.st.protocolVersion = xz.version;
  xiaozhiLinks.set(device, xz);
  ws.on('close', () => {
    if (xiaozhiLinks.get(device) === xz) xiaozhiLinks.delete(device);
    floors.set(device, gate.stats().floor);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === `${BASE}/xiaozhi/ota/` || url.pathname === `${BASE}/xiaozhi/ota`) {
    const mac = String(req.headers['device-id'] || '').toLowerCase();
    if (!XIAOZHI_DEVICES.includes(mac)) {
      console.log(`[ota] 没登记的板子来领地址：${mac || '（没有 Device-Id）'}`);
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"device not registered"}');
      return;
    }
    req.resume();
    const firmware = latestFirmware(boardOf(req.headers['user-agent']));
    console.log(`[ota] ${mac} 来领地址，板子固件 ${req.headers['user-agent'] || '?'}，服务器上最新 ${firmware?.version ?? '无'}`);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(otaResponse({ wsUrl: PUBLIC_WS, token: DEVICE_TOKEN, firmware })));
    return;
  }
  const fw = url.pathname.match(new RegExp(`^${BASE}/xiaozhi/firmware/([\\w.-]+\\.bin)$`));
  if (req.method === 'GET' && fw) {
    const file = path.join(FIRMWARE_DIR, fw[1]);
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404).end(); return; }
      console.log(`[ota] 有板子在下载 ${fw[1]}`);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  // 记声纹：POST /xiaozhi/enroll?name=我&seconds=15（要令牌），板子接下来说的话算这个人
  if (url.pathname === `${BASE}/xiaozhi/enroll` && req.method === 'POST') {
    if (!tokenOk(req, url)) { res.writeHead(401).end(); return; }
    const device = url.searchParams.get('device') || [...xiaozhiLinks.keys()][0];
    const st = status.devices.get(device);
    const named = url.searchParams.has('name') ? url.searchParams.get('name') : '我';
    const ok = st?.startEnroll?.(named ?? '我', Date.now(), Number(url.searchParams.get('seconds') || 15));
    res.writeHead(ok ? 202 : 404).end(ok ? 'ok' : '板子不在线或没有声纹模型');
    return;
  }
  // 调屏幕用：POST 让板子截屏，GET 拿最近一张（要令牌）
  if (url.pathname === `${BASE}/xiaozhi/snapshot`) {
    if (!tokenOk(req, url)) { res.writeHead(401).end(); return; }
    const device = url.searchParams.get('device') || [...xiaozhiLinks.keys()][0];
    if (req.method === 'POST') {
      const link = xiaozhiLinks.get(device);
      if (!link) { res.writeHead(404).end('板子不在线'); return; }
      link.requestSnapshot();
      res.writeHead(202).end('ok');
      return;
    }
    const snap = status.devices.get(device)?.snapshot;
    if (!snap) { res.writeHead(404).end('还没有截屏'); return; }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'x-snapshot-at': snap.at });
    res.end(snap.jpeg);
    return;
  }
  if (req.method === 'GET' && url.pathname === `${BASE}/health`) {
    const today = beijingDate(Date.now());
    const devices = [...status.devices.values()].map((d) => ({
      device: d.device,
      online: !d.disconnectedAt || d.disconnectedAt < d.connectedAt,
      connectedAt: beijingIso(d.connectedAt),
      lastFrameAt: d.lastFrameAt ? beijingIso(d.lastFrameAt) : null,
      frames: d.frames,
      sentences: d.sentences,
      errors: d.errors,
      status: d.status ?? null,
      gate: d.gate ? d.gate.stats() : undefined,
    }));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, today, sentencesToday: daylog.count(today), devices }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const isXiaozhi = url.pathname === `${BASE}/xiaozhi/ws` || url.pathname === `${BASE}/xiaozhi/ws/`;
  if ((url.pathname !== `${BASE}/stream` && !isXiaozhi) || !tokenOk(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  // 小智板子：型号前缀 + MAC 后 4 位当名字（xiaozhi.mjs deviceName）；老固件用地址里的 device=
  const device = isXiaozhi
    ? deviceName(req.headers['user-agent'], req.headers['device-id'])
    : (url.searchParams.get('device') || 'device').replace(/[^\w-]/g, '').slice(0, 32) || 'device';
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
    if (isXiaozhi) xiaozhiSession(ws, req, device);
    else legacySession(ws, device);
  });
});

// 板子那头断了不一定发 close：30 秒一次 ping，没回应就关
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.killedByPing = true; ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

if (printStore.count()) logPrints('读回声纹');
else {
  try {
    const t = await cos.getText(VOICEPRINTS_KEY);
    const imported = loadPrints(t ? JSON.parse(t) : {});
    if (Object.keys(imported).length) {
      printStore.writeAll(imported);
      voiceprints = imported;
    }
  } catch (err) {
    console.error(`[spk] 读声纹失败：${err.message}`);
  }
  logPrints('读回声纹');
}
server.listen(PORT, HOST, () => console.log(`[voicelog] 在听 ${HOST}:${PORT}${BASE}，模型 ${ASR_MODEL}`));

async function shutdown() {
  console.log('[voicelog] 收尾：把内存里的句子写回 COS');
  server.close();
  for (const ws of wss.clients) ws.close();
  // 等识别服务吐完最后一句
  await new Promise((r) => setTimeout(r, 3000));
  await Promise.race([convs.closeAll(), new Promise((r) => setTimeout(r, 6000))]);
  await daylog.flushAll();
  await dayStats.flushAll();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
