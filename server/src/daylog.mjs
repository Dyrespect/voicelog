/**
 * 按天存的 JSONL 文件（北京时间），整份读、整份写回 COS（一天也就几百 KB）。
 * - 句子：<prefix><日期>.jsonl，每行一句 {"start","end","text","device"}，只追加。
 * - 对话：<prefix><日期>.convs.jsonl，每行一段对话，按 id 更新（见 convs.mjs）。
 * 新内容先进内存，攒 flushMs 再写。某天第一次写之前先把 COS 上已有的读回来，
 * 服务重启不会把当天的盖掉；读不到就一直重试，读到之前不写。
 */
const TZ_OFFSET_MS = 8 * 3600 * 1000;
const RETRY_MS = 15000;

export function beijingIso(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().replace('Z', '+08:00');
}

export function beijingDate(ms) {
  return beijingIso(ms).slice(0, 10);
}

/** idOf 给了就按 id 更新同一行，没给就只追加 */
export function createDayFile({ cos, prefix, suffix, idOf = null, flushMs = 10000, log = console }) {
  /** date -> { lines, loaded, dirty, timer } */
  const days = new Map();
  const keyOf = (date) => `${prefix}${date}${suffix}`;

  function load(date, d) {
    cos.getText(keyOf(date)).then((text) => {
      const have = idOf ? new Set(d.lines.map(idOf)) : null;
      for (const line of (text || '').split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (!have || !have.has(idOf(obj))) d.lines.push(obj);
        } catch { /* 坏行跳过 */ }
      }
      d.loaded = true;
      if (d.dirty) schedule(date, d);
    }, (err) => {
      log.error(`[day] 读 ${keyOf(date)} 失败，${RETRY_MS / 1000} 秒后再试：${err?.message || err}`);
      setTimeout(() => load(date, d), RETRY_MS);
    });
  }

  function day(date) {
    let d = days.get(date);
    if (!d) {
      d = { lines: [], loaded: false, dirty: false, timer: null };
      days.set(date, d);
      load(date, d);
    }
    return d;
  }

  function schedule(date, d) {
    if (!d.timer) d.timer = setTimeout(() => flush(date), flushMs);
  }

  async function flush(date) {
    const d = days.get(date);
    if (!d) return;
    clearTimeout(d.timer);
    d.timer = null;
    if (!d.dirty || !d.loaded) return;
    d.dirty = false;
    d.lines.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const body = d.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    try {
      await cos.putText(keyOf(date), body);
      // 前天及更早的写完就不留在内存里了（晚到的内容来了会重新从 COS 读）
      if (date < beijingDate(Date.now() - 86400000) && !d.dirty) days.delete(date);
    } catch (err) {
      d.dirty = true;
      log.error(`[day] 写 ${keyOf(date)} 失败，稍后再写：${err?.message || err}`);
      schedule(date, d);
    }
  }

  return {
    put(date, line) {
      const d = day(date);
      const i = idOf ? d.lines.findIndex((l) => idOf(l) === idOf(line)) : -1;
      if (i >= 0) d.lines[i] = line;
      else d.lines.push(line);
      d.dirty = true;
      schedule(date, d);
    },
    async flushAll() {
      await Promise.all([...days.keys()].map(flush));
    },
    count(date) {
      return days.get(date)?.lines.length ?? 0;
    },
    /** 这一天现有的行（还没从 COS 读回来时先触发读，返回目前内存里的） */
    lines(date) {
      return day(date).lines;
    },
  };
}

/**
 * 每台板子每天录了多久、送去识别多久：<prefix><日期>.stats.jsonl，一行一台板子 {"device","recordedMs","asrMs"}。
 * asrMs = 真正送给百炼的音频（按秒计费的就是它；安静的没送，10-16 戴敬力问“不说话也一直计费吗”）。
 * vadMs / vadMiss：认人声的新门（vad.mjs）影子跑时，它只会送多少、有几句它会漏（见 server.mjs VAD_MODE）。
 * 按帧里的时间算日子（断网攒着、第二天补传的算回当天）。内存里先累加，攒 10 秒并进文件，免得每帧都动文件。
 */
export function createDayStats({ cos, prefix, flushMs, log }) {
  const file = createDayFile({ cos, prefix, suffix: '.stats.jsonl', idOf: (l) => l.device, flushMs, log });
  const pending = new Map(); // `${date}|${device}` -> { rec, asr }
  const bump = (device, tsMs, field, durMs) => {
    const key = `${beijingDate(tsMs)}|${device}`;
    const p = pending.get(key) || { rec: 0, asr: 0, vad: 0, vadMiss: 0 };
    p[field] += durMs;
    pending.set(key, p);
  };
  const merge = () => {
    for (const [key, p] of pending) {
      const [date, device] = key.split('|');
      const row = file.lines(date).find((l) => l.device === device) || { device, recordedMs: 0 };
      file.put(date, {
        device,
        recordedMs: row.recordedMs + p.rec,
        asrMs: (row.asrMs || 0) + p.asr,
        vadMs: (row.vadMs || 0) + p.vad,
        vadMiss: (row.vadMiss || 0) + p.vadMiss,
      });
    }
    pending.clear();
  };
  const timer = setInterval(merge, 10000);
  timer.unref();
  return {
    add(device, tsMs, durMs) {
      bump(device, tsMs, 'rec', durMs);
    },
    /** 这段送去识别了 */
    addAsr(device, tsMs, durMs) {
      bump(device, tsMs, 'asr', durMs);
    },
    /** 新门（认人声）会送这段 */
    addVad(device, tsMs, durMs) {
      bump(device, tsMs, 'vad', durMs);
    },
    /** 识别出来的一句，新门会漏掉 */
    addVadMiss(device, tsMs) {
      bump(device, tsMs, 'vadMiss', 1);
    },
    recordedMs(date, device) {
      const row = file.lines(date).find((l) => l.device === device);
      return (row?.recordedMs || 0) + (pending.get(`${date}|${device}`)?.rec || 0);
    },
    async flushAll() {
      merge();
      await file.flushAll();
    },
  };
}

export function createDayLog({ cos, prefix, flushMs, log }) {
  const file = createDayFile({ cos, prefix, suffix: '.jsonl', flushMs, log });
  return {
    add({ startMs, endMs, text, device, speaker }) {
      const line = { start: beijingIso(startMs), end: beijingIso(endMs), text, device };
      if (speaker) line.speaker = speaker;
      file.put(beijingDate(startMs), line);
    },
    flushAll: file.flushAll,
    count: file.count,
    /** 某台板子这天说了几句 */
    countFor(date, device) {
      return file.lines(date).filter((l) => l.device === device).length;
    },
  };
}
