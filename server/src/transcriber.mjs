import { openAsr } from './asr.mjs';

/**
 * 一台板子的“声音 → 句子”：收带时间的 16kHz PCM，转给百炼实时识别，定稿的句子交给 onSentence。
 * 时间对不上（中间有空档：没人说话没发、断网补传）就结束当前识别任务、按新时间开一个，
 * 这样每句的时间 = 任务开头时间 + 句子在任务里的位置。
 */
const SAMPLE_RATE = 16000;
/** 两帧之间时间对不上超过这么多就当成新的一段 */
const GAP_MS = 400;
/** 这么久没收到声音就结束识别任务（让最后一句尽快定稿，也不白占连接） */
const IDLE_MS = 2500;

export function createTranscriber({ apiKey, model, vocabularyId, onSentence, onPartial, onError }) {
  let asr = null;
  let expectedTs = 0;
  let idleTimer = null;

  const close = () => {
    clearTimeout(idleTimer);
    if (asr) asr.finish();
    asr = null;
  };

  const openAt = (baseMs) => {
    const me = openAsr({ apiKey, model, vocabularyId, sampleRate: SAMPLE_RATE }, {
      onSentence: ({ text, begin, end, words }) => onSentence({
        startMs: baseMs + begin,
        endMs: baseMs + end,
        text,
        words: (words || []).map((w) => ({ startMs: baseMs + w.begin, endMs: baseMs + w.end, text: w.text })),
      }),
      onPartial,
      onError,
      onDone: () => { if (asr === me) asr = null; },
    });
    return me;
  };

  return {
    push(tsMs, pcm) {
      const durMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
      if (asr && Math.abs(tsMs - expectedTs) > GAP_MS) close();
      if (!asr) asr = openAt(tsMs);
      asr.send(pcm);
      expectedTs = tsMs + durMs;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(close, IDLE_MS);
    },
    close,
  };
}
