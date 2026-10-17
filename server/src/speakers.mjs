import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * 区分说话人（戴敬力 10-15：“至少区分出来哪些话是我说的，哪些话是第二人、第三人说的”）。
 * 照小智服务端的声纹识别（xinnan-tech/voiceprint-api）用阿里 3D-Speaker CAM++，换成 sherpa-onnx 跑 ONNX 版（28MB），
 * 不用装 PyTorch，上海那台内存够。
 *
 * - 每句定稿后，拿这句的声音（内存里最近 3 分钟，见 xiaozhiSession）算一个 192 维声纹。
 *   登记过的人（余弦 ≥ 0.55）直接算这个人，不跟当场临时编号比谁更像——临时编号是用刚才的话堆出来的，
 *   往往会比 15 秒登记更像，把“我”抢走（10-17：我=0.66、说话人14=0.89，其实都是戴敬力）。
 *   没登记的人只在这一场对话里编号（跟 convs 一样，隔 5 分钟算新的一场），不存下来。
 * - “我”和点名登记的人：声纹页选中后说 15 秒，存成数字和名字（不存声音）。说“我是戴敬力”时，名字记在“我”上。
 * - 太短的句子（< 1 秒）声纹不准，跟前一句同一个人；1–2 秒的只往已有的人上靠（不开新编号，靠不上算“其他人”）。
 * - 一句里有好几个人（来回说得快时识别会把 20 多秒并成一句）：照 WhisperX 的做法，先用 pyannote 分段模型
 *   把这句的声音按“谁在说”切开，每段认是谁，再按每个字的时间把字分给当时在说的人，切成几行（splitBySpeaker）。
 */
const SAMPLE_RATE = 16000;
/** 登记过的人：同一间屋子、同一支麦，15 秒登记对上后来的话大约 0.58–0.66；别人多在 0.45 以下。0.55 接得住本人、挡得住旁边的人。 */
export const ENROLLED_SIM = 0.55;
/** 没登记的人，当场往已有编号上靠。比登记线高一点，免得一句不像就新开一个号。 */
export const SESSION_SIM = 0.6;
/** 跟对话分段同一个空档：过了就丢掉这场的临时编号 */
export const SESSION_GAP_MS = 5 * 60 * 1000;
const MIN_SEC = 1.0;
/** 短于这个的不开新编号 */
const NEW_PERSON_SEC = 2.0;
/**
 * 长于这个的句子先做说话人分段。10-15 拿四人对话按长度滑窗测：3 秒以下误切多、切开的少；
 * 3.5 秒一个人的 44 段误切 1、两个人的 8 段切开 4；4 秒 0/40、7/10。误切的两半一般都认回同一个人、并回一行，
 * 所以取 3.5 秒（实测“在超市等你可不可以？可以雨伞拿着。”3.7 秒混了两个人）。
 */
const SPLIT_SEC = 3.5;
/** 分句（到逗号句号问号）结尾的标点；“、”不算（“有屏幕、有话筒”是一个人在列举） */
const CLAUSE_END = /[，。！？；：,.!?;:]$/;
/** 比这还长、中间没标点的分句不整句投票，还是按字分 */
const MAX_CLAUSE_MS = 6000;

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export function mean(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < v.length; i += 1) out[i] += v[i] / vectors.length;
  return normalize(out);
}

function refVec(ref) {
  if (!ref) return null;
  if (ref instanceof Float32Array || Array.isArray(ref)) return ref;
  if (Array.isArray(ref.v) || ref.v instanceof Float32Array) return ref.v;
  return null;
}

const BAD_NAMES = new Set(['我', '其他人', '说话人', '新增', '主人', '我是', '我叫', '这个', '那个', '什么', '没有', '不是', '自己', '我们', '他们']);

/** 模型或转写里的名字：2–4 个汉字。空的、口头禅、编号都丢掉。 */
export function cleanName(raw) {
  let s = String(raw || '').trim().replace(/^[「『"'“\s]+|[」』"'”\s。！？，、]+$/g, '');
  s = s.replace(/^(我是|我叫|这是|叫做|名叫)/, '');
  s = s.replace(/(同学|老师|先生|女士)$/g, '');
  if (s.length > 4) {
    const head = /^[\u4e00-\u9fff]{2,4}/.exec(s);
    s = head ? head[0] : '';
  }
  if (!/^[\u4e00-\u9fff]{2,4}$/.test(s) || BAD_NAMES.has(s) || s.startsWith('说话')) return '';
  return s;
}

/** 没叫到模型时，从“我是戴敬力，戴帽子的戴”里先抓住名字 */
export function guessName(text) {
  const m = /我(?:是|叫)\s*([\u4e00-\u9fff]{2,4})/.exec(String(text || ''));
  return m ? cleanName(m[1]) : '';
}

/** COS 里的声纹。旧文件是 {我: [192 个数]}，新的是 {我: {v, name}}。 */
export function loadPrints(obj) {
  const out = {};
  for (const [id, raw] of Object.entries(obj || {})) {
    const v = Array.isArray(raw) ? raw : raw?.v;
    if (!Array.isArray(v) || !v.length) continue;
    const name = Array.isArray(raw) ? '' : (cleanName(raw?.name) || '');
    out[id] = { v: Float32Array.from(v), name };
  }
  return out;
}

export function savePrints(prints) {
  return Object.fromEntries(Object.entries(prints).map(([id, p]) => [id, { v: Array.from(p.v), name: p.name || '' }]));
}

/** 板子声纹页上的名单。永远有「我」和「新增」。 */
export function peoplePayload(prints) {
  const me = prints?.['我'];
  const list = [{ id: '我', name: me?.name || '', enrolled: !!me }];
  for (const [id, p] of Object.entries(prints || {})) {
    if (id === '我') continue;
    list.push({ id, name: p.name || id, enrolled: true });
  }
  list.push({ id: '', name: '新增', enrolled: false });
  return list;
}

/** 16 位 PCM → 声纹。extractor 由调用方给（测试里可以换成假的） */
export function createEmbedder(modelPath) {
  const sherpa = require('sherpa-onnx-node');
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false });
  return (pcm) => {
    const n = pcm.length / 2;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i += 1) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    return normalize(extractor.compute(stream));
  };
}

/**
 * 一场对话里的说话人。enrolled：{名字: 声纹}，只读，不用当场的话去改它。
 * identify(pcm, atMs) → 名字。atMs 跟上一句隔过 sessionGapMs，临时编号清掉重来。
 */
export function createSpeakerBook({
  embed, enrolled = () => ({}), threshold = SESSION_SIM, enrolledThreshold = ENROLLED_SIM,
  sessionGapMs = SESSION_GAP_MS, log = null,
}) {
  const people = []; // { name, centroid, count } 只活在这一场
  let last = '';
  let lastMs = 0;
  return {
    identify(pcm, atMs = 0) {
      if (atMs && lastMs && atMs - lastMs > sessionGapMs) {
        people.length = 0;
        last = '';
      }
      if (atMs) lastMs = atMs;
      const durSec = pcm.length / 2 / SAMPLE_RATE;
      if (durSec < MIN_SEC) return last || '其他人';
      const v = embed(pcm);
      const shortOne = durSec < NEW_PERSON_SEC;
      const enrolledEntries = Object.entries(enrolled())
        .map(([name, ref]) => [name, refVec(ref)])
        .filter(([, vec]) => vec);

      let best = '';
      let bestSim = -1;
      // 过了登记线就认这个人。不跟临时编号抢：临时编号是用他刚才的话平均出来的，数字总会更高。
      for (const [name, vec] of enrolledEntries) {
        const sim = cosine(v, vec);
        if (sim >= enrolledThreshold && sim > bestSim) { best = name; bestSim = sim; }
      }
      if (!best) {
        for (const p of people) {
          const sim = cosine(v, p.centroid);
          if (sim >= threshold && sim > bestSim) { best = p.name; bestSim = sim; }
        }
        // 短句子：门槛放低一点往已有的人上靠，靠不上算“其他人”，不开新编号（10-15：一句“好吧”多出一个说话人）
        if (!best && shortOne) {
          const relaxed = threshold - 0.1;
          const enrolledRelaxed = Math.min(enrolledThreshold, relaxed);
          for (const [name, vec] of enrolledEntries) {
            const sim = cosine(v, vec);
            if (sim >= enrolledRelaxed && sim > bestSim) { best = name; bestSim = sim; }
          }
          for (const p of people) {
            const sim = cosine(v, p.centroid);
            if (sim >= relaxed && sim > bestSim) { best = p.name; bestSim = sim; }
          }
          if (!best) best = '其他人';
        }
        const hit = people.find((p) => p.name === best);
        if (hit && !shortOne) {
          // 只挪临时编号。登记的声纹不跟着当天的话漂。
          hit.centroid = mean([hit.centroid, hit.centroid, hit.centroid, v]);
          hit.count += 1;
        } else if (!best) {
          best = `说话人${people.length + 2}`; // “我”占 1 号，别人从 2 开始
          people.push({ name: best, centroid: v, count: 1 });
        }
      }
      last = best;
      if (log) {
        const sims = [
          ...enrolledEntries.map(([n, r]) => [n, cosine(v, r)]),
          ...people.map((p) => [p.name, cosine(v, p.centroid)]),
        ];
        log(`${best} ${durSec.toFixed(1)}s ${sims.map(([n, s]) => `${n}=${s.toFixed(2)}`).join(' ')}`);
      }
      return best;
    },
    embed,
  };
}

export const DEFAULT_MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', 'campplus_zh.onnx');

/** pyannote 分段 + CAM++：一段声音里“几点到几点是第几个人”（这一段里的编号，不是全天的） */
export function createDiarizer({ segmentationModel, embeddingModel }) {
  const sherpa = require('sherpa-onnx-node');
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: segmentationModel, windowShiftRatio: 0.5 }, numThreads: 2 },
    embedding: { model: embeddingModel, numThreads: 2 },
    // 10-15 拿 sherpa 自带的四人对话测：步长 0.5、阈值 0.7，57 秒 1.3 秒算完，四个人分对
    clustering: { numClusters: -1, threshold: 0.7 },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  return (pcm) => {
    const n = pcm.length / 2;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i += 1) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    return sd.process(samples).map((x) => ({ start: x.start, end: x.end, speaker: x.speaker }));
  };
}

/**
 * 把一句按说话人切成几行。sentence：{ startMs, endMs, text, words: [{startMs, endMs, text}] }；
 * pcm/pcmStartMs：这句的声音和它第一个采样的时间。返回 [{ startMs, endMs, text, speaker }]。
 */
export function splitBySpeaker({ sentence, pcm, pcmStartMs, book, diarize }) {
  const whole = () => [{ startMs: sentence.startMs, endMs: sentence.endMs, text: sentence.text, speaker: book.identify(pcm, sentence.startMs) }];
  const durSec = pcm.length / 2 / SAMPLE_RATE;
  if (!diarize || durSec < SPLIT_SEC || !sentence.words?.length) return whole();
  const segs = diarize(pcm);
  const locals = [...new Set(segs.map((x) => x.speaker))];
  if (locals.length <= 1) return whole();

  // 每个“这一段里的人”的声音拼起来认是谁（全天编号）
  const nameOf = new Map();
  for (const k of locals) {
    const parts = segs.filter((x) => x.speaker === k).map((x) => pcm.subarray(Math.floor(x.start * SAMPLE_RATE) * 2, Math.floor(x.end * SAMPLE_RATE) * 2));
    nameOf.set(k, book.identify(Buffer.concat(parts), sentence.startMs));
  }
  // 每个字给重叠最多的那段的人；哪段都不挨着就给离得最近的
  const who = sentence.words.map((w) => {
    const a = (w.startMs - pcmStartMs) / 1000;
    const b = (w.endMs - pcmStartMs) / 1000;
    let best = null;
    let bestScore = -Infinity;
    for (const x of segs) {
      const overlap = Math.min(b, x.end) - Math.max(a, x.start);
      const score = overlap > 0 ? overlap : -Math.min(Math.abs(a - x.end), Math.abs(x.start - b));
      if (score > bestScore) { bestScore = score; best = x; }
    }
    return nameOf.get(best.speaker);
  });
  // 一个分句只给一个人：这句里谁说得最久给谁（照 whisper-diarization 按标点重新对齐）。
  // 分段和字时间都有零点几秒误差，直接按字切会切在词中间（10-15 实测“伴读机器 / 人我最后打算用的”“我先跟你说 / 话，”）
  const words = sentence.words;
  let from = 0;
  words.forEach((w, i) => {
    if (!CLAUSE_END.test(w.text) && i < words.length - 1) return;
    if (words[i].endMs - words[from].startMs <= MAX_CLAUSE_MS) {
      const total = new Map();
      for (let j = from; j <= i; j += 1) total.set(who[j], (total.get(who[j]) || 0) + Math.max(1, words[j].endMs - words[j].startMs));
      const top = [...total].sort((x, y) => y[1] - x[1])[0][0];
      for (let j = from; j <= i; j += 1) who[j] = top;
    }
    from = i + 1;
  });
  // 连着是同一个人的字并成一行
  const out = [];
  sentence.words.forEach((w, i) => {
    const last = out[out.length - 1];
    if (last && last.speaker === who[i]) {
      last.text += w.text;
      last.endMs = w.endMs;
    } else {
      out.push({ startMs: w.startMs, endMs: w.endMs, text: w.text, speaker: who[i] });
    }
  });
  return out;
}

export const DEFAULT_SEGMENTATION_MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', 'segmentation.onnx');

/** 屏幕上的短名字：“说话人2”→“二号”，“其他人”→“其他”，“我”不变 */
export function shortWho(speaker) {
  if (!speaker) return '';
  const m = /^说话人(\d+)$/.exec(speaker);
  if (m) return `${'〇一二三四五六七八九十'[Number(m[1])] ?? m[1]}号`;
  if (speaker === '其他人') return '其他';
  return speaker;
}
