// 分段和起标题的逻辑（假 COS、假模型，不花钱）：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConvs } from '../src/convs.mjs';

function fakeCos() {
  const files = new Map();
  return { files, getText: async (k) => files.get(k) ?? null, putText: async (k, t) => { files.set(k, t); } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 用今天（北京）的日子：服务端会把前天以前的日子写完就从内存里扔掉（daylog.mjs），写死日期过两天测试就不对了
const DAY = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const T0 = Date.parse(`${DAY}T06:00:00Z`); // 北京 14:00

test('凑够 1 分钟起一次标题；隔 5 分钟以上算新对话；结束时没标题的补上', async () => {
  const cos = fakeCos();
  const asked = [];
  const titler = async (text) => { asked.push(text); return { title: `标题${asked.length}`, summary: '一句话' }; };
  const convs = createConvs({ cos, prefix: 'v/', titler, flushMs: 5, log: { error() {} } });
  // 第一段：0–70 秒，每 10 秒一句
  for (let s = 0; s <= 70; s += 10) convs.add({ device: 'd', startMs: T0 + s * 1000, endMs: T0 + s * 1000 + 3000, text: `第一段第${s}秒` });
  // 第二段：10 分钟后，只说 2 句就没了
  convs.add({ device: 'd', startMs: T0 + 600000, endMs: T0 + 603000, text: '第二段开头，后面不要' });
  convs.add({ device: 'd', startMs: T0 + 610000, endMs: T0 + 613000, text: '第二段第二句' });
  convs.tick(T0 + 613000 + 5 * 60000 + 1);
  await wait(30);
  assert.equal(asked.length, 2, '每段只问一次');
  assert.ok(!asked[0].includes('第一段第70秒'), '只拿开头 1 分钟');
  assert.ok(asked[0].includes('第一段第0秒'));
  const rows = cos.files.get(`v/${DAY}.convs.jsonl`).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.title), ['标题1', '标题2']);
  assert.equal(rows[0].start, `${DAY}T14:00:00.000+08:00`);
  assert.equal(rows[0].end, `${DAY}T14:01:13.000+08:00`);
  assert.equal(rows[0].sentences, 8);
});

test('模型出错时拿第一句顶上', async () => {
  const cos = fakeCos();
  const convs = createConvs({ cos, prefix: 'v/', titler: async () => { throw new Error('挂了'); }, flushMs: 5, log: { error() {} } });
  convs.add({ device: 'd', startMs: T0, endMs: T0 + 2000, text: '明天去滨江看场地，带上板子' });
  await convs.closeAll();
  const row = JSON.parse(cos.files.get(`v/${DAY}.convs.jsonl`).trim());
  assert.equal(row.title, '明天去滨江看场地');
});

test('板子屏幕要的数：今天几段、上一段的时间和标题（包括还在进行的那段）', async () => {
  const cos = fakeCos();
  const titler = async () => ({ title: '标题', summary: '' });
  const convs = createConvs({ cos, prefix: 'v/', titler, flushMs: 5, log: { error() {} } });
  convs.add({ device: 'd', startMs: T0, endMs: T0 + 2000, text: '第一段' });
  convs.add({ device: 'd', startMs: T0 + 600000, endMs: T0 + 602000, text: '第二段刚开口' });
  convs.add({ device: 'other', startMs: T0, endMs: T0 + 2000, text: '别的板子' });
  await wait(20);
  const t = convs.today(`${DAY}`, 'd');
  assert.equal(t.segments, 2);
  assert.equal(t.lastStart, '14:10');
});
