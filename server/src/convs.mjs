import { beijingDate, beijingIso, createDayFile } from './daylog.mjs';

/**
 * 把句子分成一段段对话，每段起个小标题，方便以后按标题找（戴敬力 2026-10-15）。
 * - 一段对话 = 同一台板子、前后两句隔不到 5 分钟的一串句子。
 * - 对话凑够 1 分钟（或 10 句）时，拿开头这 1 分钟请小模型起标题和一句话说明；
 *   不到 1 分钟就结束的，结束时再起。每段只调一次模型。
 * - 每段一行写进 <prefix><日期>.convs.jsonl：
 *   {"id","start","end","title","summary","sentences","device"}，id = 刚开始时的开头时间，之后不变。
 */
const GAP_MS = 5 * 60000;
const TITLE_AFTER_MS = 60000;
const TITLE_AFTER_N = 10;
const HEAD_MS = 60000;
const HEAD_MAX_CHARS = 800;

const SYSTEM = `下面是一段日常对话录音转写的开头，可能有识别错的字，也可能混着旁边人的话。
给这段对话起一个标题，再用一句话说明在聊什么，方便以后按标题查找。
要求：标题不超过 12 个字，写具体的人、事、地点，不写“关于”“讨论”“对话”这类空词；一句话说明不超过 30 个字；照原话的意思，不编没出现的内容。
只输出 JSON：{"title":"…","summary":"…"}`;

/** 百炼兼容接口，写法照 LineHere server/src/modules/speech/speech.tidy.ts */
export function createTitler({ apiKey, model }) {
  return async (text) => {
    const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const out = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return { title: String(out.title || '').trim().slice(0, 20), summary: String(out.summary || '').trim().slice(0, 60) };
  };
}

export function createConvs({ cos, prefix, titler, flushMs, log = console }) {
  const file = createDayFile({ cos, prefix, suffix: '.convs.jsonl', idOf: (l) => `${l.device}|${l.id}`, flushMs, log });
  /** device -> 正在进行的对话 */
  const open = new Map();
  const open_ = open;

  function save(c) {
    file.put(beijingDate(c.idMs), {
      id: beijingIso(c.idMs),
      start: beijingIso(c.startMs),
      end: beijingIso(c.endMs),
      title: c.title,
      summary: c.summary,
      sentences: c.lines.length,
      device: c.device,
    });
  }

  async function name(c) {
    if (c.titled) return;
    c.titled = true;
    const head = c.lines.filter((l) => l.startMs < c.startMs + HEAD_MS).map((l) => l.text).join('\n').slice(0, HEAD_MAX_CHARS);
    try {
      const r = await titler(head);
      c.title = r.title;
      c.summary = r.summary;
    } catch (err) {
      log.error(`[convs] 起标题没成功：${err?.message || err}`);
    }
    // 模型不行就拿第一句顶上，至少能搜到
    if (!c.title) c.title = c.lines[0].text.replace(/[，。！？,.!?].*$/, '').slice(0, 12);
    save(c);
  }

  function close(c) {
    if (open.get(c.device) === c) open.delete(c.device);
    return c.titled ? (save(c), Promise.resolve()) : name(c);
  }

  return {
    add({ device, startMs, endMs, text }) {
      let c = open.get(device);
      if (c && startMs - c.endMs > GAP_MS) {
        close(c);
        c = null;
      }
      if (!c) {
        c = { device, idMs: startMs, startMs, endMs, lines: [], title: '', summary: '', titled: false };
        open.set(device, c);
      }
      c.lines.push({ startMs, text });
      c.startMs = Math.min(c.startMs, startMs);
      c.endMs = Math.max(c.endMs, endMs);
      if (!c.titled && (c.endMs - c.startMs >= TITLE_AFTER_MS || c.lines.length >= TITLE_AFTER_N)) name(c);
      else save(c);
    },
    /** 隔一会儿调一次：5 分钟没新句子的对话算结束 */
    tick(now = Date.now()) {
      for (const c of [...open.values()]) if (now - c.endMs > GAP_MS) close(c);
    },
    /** 某台板子这天的对话：几段、最近一段的开始时间和标题（板子屏幕上显示） */
    today(date, device) {
      const rows = file.lines(date).filter((l) => l.device === device);
      const open = open_.get(device);
      if (open && beijingDate(open.idMs) === date && !rows.some((r) => r.id === beijingIso(open.idMs))) {
        rows.push({ id: beijingIso(open.idMs), start: beijingIso(open.startMs), title: open.title });
      }
      rows.sort((a, b) => (a.start < b.start ? -1 : 1));
      const last = rows[rows.length - 1];
      return { segments: rows.length, lastStart: last ? last.start.slice(11, 16) : '', lastTitle: last ? last.title || '' : '' };
    },
    async closeAll() {
      await Promise.all([...open.values()].map(close));
      await file.flushAll();
    },
  };
}
