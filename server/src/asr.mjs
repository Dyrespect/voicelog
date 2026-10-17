import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/**
 * 百炼实时语音识别（paraformer-realtime-v2）。
 * 照抄 LineHere server/src/modules/speech/adapters/dashscopeAsr.adapter.ts，多拿了每句的起止时间。
 * 协议：run-task → 二进制 PCM → finish-task；sentence_end=true 是一句定稿。
 * begin_time / end_time 是这句在本次任务收到的音频里的毫秒位置。
 */
const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const START_TIMEOUT_MS = 8000;
const FINISH_TIMEOUT_MS = 20000;

/**
 * @param {{apiKey: string, model: string, sampleRate: number, vocabularyId?: string}} opts
 * @param {{onSentence: (s: {text: string, begin: number, end: number, words: {begin: number, end: number, text: string}[]}) => void, onPartial?: (text: string) => void, onError: (detail: string) => void, onDone: () => void}} handlers
 */
export function openAsr(opts, handlers) {
  const taskId = randomUUID();
  const header = (action) => ({ action, task_id: taskId, streaming: 'duplex' });
  const upstream = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
  const pending = [];
  let started = false;
  let finishing = false;
  let done = false;

  const startTimer = setTimeout(() => {
    if (started || done) return;
    handlers.onError(`${START_TIMEOUT_MS / 1000} 秒没连上识别服务`);
    end();
  }, START_TIMEOUT_MS);

  const end = () => {
    if (done) return;
    done = true;
    clearTimeout(startTimer);
    handlers.onDone();
    try { upstream.close(); } catch { /* 已经关了 */ }
  };

  const sendFinish = () => upstream.send(JSON.stringify({ header: header('finish-task'), payload: { input: {} } }));

  upstream.on('open', () => {
    upstream.send(JSON.stringify({
      header: header('run-task'),
      payload: {
        task_group: 'audio', task: 'asr', function: 'recognition', model: opts.model,
        // 语气词去掉、只认中文：同 LineHere（小鱼实测不加 zh 时噪声偶尔被识别成日文）
        parameters: {
          format: 'pcm', sample_rate: opts.sampleRate, language_hints: ['zh'], disfluency_removal_enabled: true,
          // 热词表（hotwords.txt → node hotwords.mjs）：初帧、竹涧云这些专有名词优先认对
          ...(opts.vocabularyId ? { vocabulary_id: opts.vocabularyId } : {}),
        },
        input: {},
      },
    }));
  });

  upstream.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const event = msg?.header?.event;
    if (event === 'task-started') {
      started = true;
      clearTimeout(startTimer);
      for (const chunk of pending.splice(0)) upstream.send(chunk);
      if (finishing) sendFinish();
    } else if (event === 'result-generated') {
      const s = msg.payload?.output?.sentence;
      if (!s || s.heartbeat) return;
      const text = String(s.text || '').trim();
      if (!s.sentence_end) {
        // 这句还没说完：到目前为止的全文（板子屏幕上边说边出字用）
        if (text && handlers.onPartial) handlers.onPartial(text);
        return;
      }
      // 每个字词的起止时间（区分说话人时按它把一句切开给不同的人）
      const words = Array.isArray(s.words)
        ? s.words.map((w) => ({ begin: Number(w.begin_time) || 0, end: Number(w.end_time) || 0, text: `${w.text || ''}${w.punctuation || ''}` }))
        : [];
      if (text) handlers.onSentence({ text, begin: Number(s.begin_time) || 0, end: Number(s.end_time) || 0, words });
    } else if (event === 'task-finished') {
      end();
    } else if (event === 'task-failed') {
      handlers.onError(`${msg.header?.error_code || ''} ${msg.header?.error_message || '识别任务失败'}`);
      end();
    }
  });

  upstream.on('unexpected-response', (_req, res) => {
    handlers.onError(`握手被拒 HTTP ${res.statusCode}`);
    end();
  });
  upstream.on('error', (err) => {
    if (done) return;
    handlers.onError(err.message);
    end();
  });
  upstream.on('close', end);

  return {
    send(pcm) {
      if (done || finishing) return;
      if (started) upstream.send(pcm);
      else pending.push(pcm);
    },
    /** 不再有音频了，等识别服务出完最后一句 */
    finish() {
      if (done || finishing) return;
      finishing = true;
      if (started) sendFinish();
      // 识别服务迟迟不回 task-finished 也要放掉这条连接
      setTimeout(end, FINISH_TIMEOUT_MS).unref();
    },
  };
}
