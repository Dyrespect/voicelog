// 从 COS 拉某天的转写，打到屏幕上（默认不在本地留文件）。
// 用法：node pull.mjs [今天|昨天|2026-10-15] [--json] [--save 目录] [--list] [--titles]
//   默认：按对话分段，每段带小标题和时间；--json：原样输出句子 JSONL；--save：存成 <目录>/<日期>.md
//   --list：列出 COS 上有哪些天；--titles：列出所有天的对话标题（找东西先看这个）
// 密钥：环境变量 COS_SECRET_ID / COS_SECRET_KEY，没有就读 VOICELOG_ENV 指的 .env。
import fs from 'node:fs';
import path from 'node:path';
import { createCos } from './src/cos.mjs';
import { beijingDate } from './src/daylog.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = readEnvFile(process.env.VOICELOG_ENV || path.join(process.cwd(), '.env'));
const get = (k, dflt) => process.env[k] || fileEnv[k] || dflt;
const cos = createCos({
  secretId: get('COS_SECRET_ID'),
  secretKey: get('COS_SECRET_KEY'),
  bucket: get('COS_BUCKET', 'tongzhuang-media-1443290206'),
  region: get('COS_REGION', 'ap-guangzhou'),
});
const prefix = get('VOICELOG_PREFIX', 'voicelog/');

const parse = (text) => (text || '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const hm = (iso) => iso.slice(11, 16);

// 不用 process.exit：输出接到管道时会把还没写出去的截掉（10-15 踩过），写完自然退出
async function main() {
if (flag('list')) {
  for (const o of await cos.list(prefix)) {
    if (o.key.endsWith('.convs.jsonl')) continue;
    console.log(`${o.key.slice(prefix.length).replace('.jsonl', '')}  ${(o.size / 1024).toFixed(1)} KB`);
  }
  return;
}

if (flag('titles')) {
  for (const o of await cos.list(prefix)) {
    if (!o.key.endsWith('.convs.jsonl')) continue;
    const date = o.key.slice(prefix.length, prefix.length + 10);
    for (const c of parse(await cos.getText(o.key))) {
      console.log(`${date} ${hm(c.start)}–${hm(c.end)}  ${c.title}${c.summary ? ' — ' + c.summary : ''}`);
    }
  }
  return;
}

const which = args.find((a) => !a.startsWith('--') && a !== value('save')) || '今天';
const date = which === '今天' || which === 'today' ? beijingDate(Date.now())
  : which === '昨天' || which === 'yesterday' ? beijingDate(Date.now() - 86400000)
  : which;

const text = await cos.getText(`${prefix}${date}.jsonl`);
if (!text) {
  console.error(`${date} 没有记录`);
  process.exitCode = 1;
  return;
}
if (flag('json')) {
  // 不能写完马上 process.exit：输出接到管道时后半截还没写出去就被截断（10-15 踩过）
  process.stdout.write(text);
} else {

const lines = parse(text);
const convs = parse(await cos.getText(`${prefix}${date}.convs.jsonl`));
// 和服务端一样按 5 分钟的空档分段；每段找时间上重叠的那条对话记录拿标题
const groups = [];
for (const l of lines) {
  const g = groups[groups.length - 1];
  if (g && Date.parse(l.start) - Date.parse(g.end) <= 5 * 60000) {
    g.lines.push(l);
    if (l.end > g.end) g.end = l.end;
  } else {
    groups.push({ start: l.start, end: l.end, lines: [l] });
  }
}
let md = `# ${date} 随身录音\n`;
// 录了多久、送去识别多久（按秒计费的是后者，0.00024 元/秒；asrMs 10-16 起才有）
const stats = parse(await cos.getText(`${prefix}${date}.stats.jsonl`));
const recMs = stats.reduce((a, r) => a + (r.recordedMs || 0), 0);
const asrMs = stats.reduce((a, r) => a + (r.asrMs || 0), 0);
if (recMs) {
  md += `\n录了 ${(recMs / 3600000).toFixed(1)} 小时`;
  md += stats.some((r) => r.asrMs != null)
    ? `，送去识别 ${Math.round(asrMs / 60000)} 分钟（约 ${(asrMs / 1000 * 0.00024).toFixed(2)} 元）`
    : '';
  // 认人声的新门影子跑（10-17 起）：它只会送多少、有几句它会漏
  const vadMs = stats.reduce((a, r) => a + (r.vadMs || 0), 0);
  const vadMiss = stats.reduce((a, r) => a + (r.vadMiss || 0), 0);
  if (stats.some((r) => r.vadMs != null)) md += `；新门只会送 ${Math.round(vadMs / 60000)} 分钟，会漏 ${vadMiss} 句`;
  md += '\n';
}
for (const g of groups) {
  const c = convs.find((x) => x.start <= g.end && x.end >= g.start);
  md += `\n## ${hm(g.start)}–${hm(g.end)} ${c?.title || '（没有标题）'}\n`;
  if (c?.summary) md += `${c.summary}\n`;
  md += '\n' + g.lines.map((l) => {
    const who = !l.speaker ? '' : (l.name && l.name !== l.speaker ? `${l.speaker}（${l.name}）：` : `${l.speaker}：`);
    return `${l.start.slice(11, 19)}  ${who}${l.text}`;
  }).join('\n') + '\n';
}

const saveDir = value('save');
if (saveDir) {
  fs.mkdirSync(saveDir, { recursive: true });
  const out = path.join(saveDir, `${date}.md`);
  fs.writeFileSync(out, md);
  console.log(`存到 ${out}（${lines.length} 句）`);
} else {
  process.stdout.write(md);
}
}
}

await main();
