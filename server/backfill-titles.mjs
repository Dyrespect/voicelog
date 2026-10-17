// 给某天还没有标题的对话补标题（比如那会儿服务没开起标题，或者服务挂过）。
// 用法（服务器上）：cd /opt/voicelog && set -a && . ./.env && set +a && node backfill-titles.mjs 2026-10-15
// 注意：要在服务端还没写过这天的 .convs.jsonl 之前跑（服务端只在启动后第一次写时读一次），
// 或者跑之前先停服务、跑完再开。
import { createCos } from './src/cos.mjs';
import { createTitler } from './src/convs.mjs';
import { beijingDate } from './src/daylog.mjs';

const env = process.env;
const date = process.argv[2] || beijingDate(Date.now());
const prefix = env.VOICELOG_PREFIX || 'voicelog/';
const cos = createCos({ secretId: env.COS_SECRET_ID, secretKey: env.COS_SECRET_KEY, bucket: env.COS_BUCKET, region: env.COS_REGION });
const titler = createTitler({ apiKey: env.DASHSCOPE_API_KEY, model: env.TITLE_MODEL || 'qwen-flash' });
const parse = (t) => (t || '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const lines = parse(await cos.getText(`${prefix}${date}.jsonl`));
const convKey = `${prefix}${date}.convs.jsonl`;
const convs = parse(await cos.getText(convKey));
const groups = [];
for (const l of lines) {
  const g = groups[groups.length - 1];
  if (g && g.device === l.device && Date.parse(l.start) - Date.parse(g.end) <= 5 * 60000) {
    g.lines.push(l);
    if (l.end > g.end) g.end = l.end;
  } else groups.push({ device: l.device, start: l.start, end: l.end, lines: [l] });
}
let added = 0;
for (const g of groups) {
  if (convs.some((c) => c.device === g.device && c.start <= g.end && c.end >= g.start)) continue;
  const head = g.lines.filter((l) => Date.parse(l.start) < Date.parse(g.start) + 60000).map((l) => l.text).join('\n').slice(0, 800);
  let r = { title: '', summary: '' };
  try { r = await titler(head); } catch (err) { console.error(`起标题没成功：${err.message}`); }
  const title = r.title || g.lines[0].text.replace(/[，。！？,.!?].*$/, '').slice(0, 12);
  convs.push({ id: g.start, start: g.start, end: g.end, title, summary: r.summary, sentences: g.lines.length, device: g.device });
  added += 1;
  console.log(`${g.start.slice(11, 16)}–${g.end.slice(11, 16)}  ${title}${r.summary ? ' — ' + r.summary : ''}`);
}
convs.sort((a, b) => (a.start < b.start ? -1 : 1));
if (added) await cos.putText(convKey, convs.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`${date}：补了 ${added} 段，共 ${convs.length} 段`);
