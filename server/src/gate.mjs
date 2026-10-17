/**
 * 服务端判断“这一帧有没有人在说话”，只把有人说话的部分（前带 1 秒、后带 5 秒）交给识别，省识别的钱。
 * 小智固件一直往上发（Opus 16kbps，流量不大），放在服务端挑：调参不用重新烧固件。
 * 判断：比环境底噪大 ratio 倍、而且不低于 minRms。底噪往下跟得快、往上跟得慢（同老固件 firmware/src/main.cpp）。
 */
export function rmsOf(pcm) {
  let acc = 0;
  const n = pcm.length / 2;
  for (let i = 0; i < n; i += 1) {
    const v = pcm.readInt16LE(i * 2);
    acc += v * v;
  }
  return n ? Math.sqrt(acc / n) : 0;
}

/** floor：接着上一段连接的底噪（板子熄屏时 30 秒连一次，每次从 1000 重新学会丢掉开头轻声的话） */
export function createGate({ ratio = 2.2, minRms = 100, preMs = 1000, hangMs = 5000, floor: startFloor = 1000, onPass }) {
  let floor = startFloor;
  let lastLoudTs = -Infinity;
  const pre = [];
  let preDur = 0;
  let lastRms = 0;

  return {
    push(tsMs, pcm, durMs) {
      const rms = rmsOf(pcm);
      lastRms = rms;
      const loud = rms > floor * ratio && rms > minRms;
      // 每 100ms 往上跟 0.2%（按帧长折算）
      const up = 0.002 * (durMs / 100);
      floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * (1 - up) + rms * up;
      if (loud) {
        for (const f of pre.splice(0)) onPass(f.tsMs, f.pcm, f.durMs);
        preDur = 0;
        lastLoudTs = tsMs;
        onPass(tsMs, pcm, durMs);
        return;
      }
      if (tsMs - lastLoudTs <= hangMs) {
        onPass(tsMs, pcm, durMs);
        return;
      }
      pre.push({ tsMs, pcm, durMs });
      preDur += durMs;
      while (preDur > preMs && pre.length) preDur -= pre.shift().durMs;
    },
    stats() {
      return { floor: Math.round(floor), rms: Math.round(lastRms) };
    },
  };
}
