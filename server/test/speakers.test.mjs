// 区分说话人的规则（假声纹，不加载模型、不花钱）
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, createSpeakerBook, guessName, loadPrints, peoplePayload, shortWho, splitBySpeaker } from '../src/speakers.mjs';

// 用 PCM 第一个字节当“是谁”，假声纹是对应方向的单位向量；长度决定时长
const pcmOf = (who, sec) => { const b = Buffer.alloc(Math.round(sec * 32000)); b[0] = who; return b; };
const axis = (i) => { const v = new Float32Array(8); v[i] = 1; return v; };
const embed = (pcm) => axis(pcm[0]);

test('同一个人同一个名字；新声音编号从说话人2开始；太短的句子跟前一句', () => {
  const book = createSpeakerBook({ embed });
  assert.equal(book.identify(pcmOf(1, 2)), '说话人2');
  assert.equal(book.identify(pcmOf(1, 3)), '说话人2');
  assert.equal(book.identify(pcmOf(2, 2)), '说话人3');
  assert.equal(book.identify(pcmOf(1, 0.5)), '说话人3'); // 太短，跟前一句
  assert.equal(book.identify(pcmOf(1, 2)), '说话人2');
});

test('登记过的“我”优先认出来，不占编号', () => {
  const book = createSpeakerBook({ embed, enrolled: () => ({ 我: axis(5) }) });
  assert.equal(book.identify(pcmOf(5, 2)), '我');
  assert.equal(book.identify(pcmOf(3, 2)), '说话人2');
});

test('“我”过了 0.55：就算这场里有更像的编号，也算我', () => {
  // 第一句不像我，开成说话人2。第二句 0.6 像我、约 0.9 像说话人2：登记过线就认我，不让临时编号抢走。
  const meLike = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  const vecs = { 1: Float32Array.from([0.2, 1, 0, 0, 0, 0, 0, 0]), 2: Float32Array.from([0.6, 0.8, 0, 0, 0, 0, 0, 0]) };
  const book = createSpeakerBook({ embed: (pcm) => vecs[pcm[0]], enrolled: () => ({ 我: meLike }) });
  assert.equal(book.identify(pcmOf(1, 2), 1_000), '说话人2');
  assert.equal(book.identify(pcmOf(2, 2), 2_000), '我');
});

test('隔了 5 分钟，没登记的人重新从说话人2编号', () => {
  const book = createSpeakerBook({ embed });
  assert.equal(book.identify(pcmOf(1, 2), 1_000), '说话人2');
  assert.equal(book.identify(pcmOf(2, 2), 2_000), '说话人3');
  assert.equal(book.identify(pcmOf(2, 2), 2_000 + 6 * 60 * 1000), '说话人2');
});

test('登记的声纹带名字也能认，空档之后还是我', () => {
  const book = createSpeakerBook({ embed, enrolled: () => ({ 我: { v: axis(5), name: '戴敬力' } }) });
  assert.equal(book.identify(pcmOf(5, 2), 1_000), '我');
  assert.equal(book.identify(pcmOf(5, 2), 1_000 + 6 * 60 * 1000), '我');
});

test('从自我介绍里抽出名字；名单永远有我和新增', () => {
  assert.equal(guessName('我是戴敬力，戴帽子的戴'), '戴敬力');
  assert.equal(guessName('我叫小红'), '小红');
  assert.equal(guessName('今天天气不错'), '');
  assert.equal(cleanName('我是戴敬力'), '戴敬力');
  assert.equal(cleanName('新增'), '');
  assert.equal(cleanName(''), '');
  const prints = loadPrints({ 我: [1, 0], 小红: { v: [0, 1], name: '小红' } });
  assert.equal(prints['我'].name, '');
  assert.equal(prints['小红'].name, '小红');
  assert.equal(prints['我'].v[0], 1);
  const list = peoplePayload(prints);
  assert.deepEqual(list.map((x) => x.id), ['我', '小红', '']);
  assert.equal(list[0].name, '');
  assert.equal(list.at(-1).name, '新增');
  assert.deepEqual(peoplePayload({}).map((x) => x.id), ['我', '']);
});

// 假分段：0–4 秒是 A、4–9 秒是 B；声音按秒填“是谁”，假声纹看第一个字节
test('长句子里两个人：按每个字的时间切成两行，名字用全天编号', () => {
  const pcm = Buffer.alloc(9 * 32000);
  for (let s = 0; s < 9; s += 1) pcm.fill(s < 4 ? 5 : 2, s * 32000, (s + 1) * 32000);
  const book = createSpeakerBook({ embed, enrolled: () => ({ 我: axis(5) }) });
  const t0 = 1_000_000;
  const w = (a, b, text) => ({ startMs: t0 + a * 1000, endMs: t0 + b * 1000, text });
  const sentence = { startMs: t0, endMs: t0 + 9000, text: '你吃了吗吃了', words: [w(0.2, 1, '你'), w(1, 2, '吃了'), w(2, 3.9, '吗？'), w(4.1, 5, '吃'), w(5, 8.5, '了。')] };
  const diarize = () => [{ start: 0, end: 4, speaker: 0 }, { start: 4.05, end: 9, speaker: 1 }];
  const parts = splitBySpeaker({ sentence, pcm, pcmStartMs: t0, book, diarize });
  assert.deepEqual(parts.map((x) => [x.speaker, x.text]), [['我', '你吃了吗？'], ['说话人2', '吃了。']]);
  assert.equal(parts[0].startMs, t0 + 200);
  assert.equal(parts[1].endMs, t0 + 8500);
});

test('短句子、分段只认出一个人、没有字时间：整句一行', () => {
  const book = createSpeakerBook({ embed });
  const pcm = pcmOf(1, 3);
  const sentence = { startMs: 0, endMs: 3000, text: '好的', words: [{ startMs: 0, endMs: 3000, text: '好的' }] };
  let called = 0;
  const diarize = () => { called += 1; return [{ start: 0, end: 3, speaker: 0 }, { start: 3, end: 6, speaker: 1 }]; };
  assert.equal(splitBySpeaker({ sentence, pcm, pcmStartMs: 0, book, diarize }).length, 1);
  assert.equal(called, 0); // 不到 3.5 秒不分段
  const long = pcmOf(1, 8);
  const one = () => [{ start: 0, end: 8, speaker: 0 }];
  assert.deepEqual(splitBySpeaker({ sentence: { ...sentence, endMs: 8000 }, pcm: long, pcmStartMs: 0, book, diarize: one }).map((x) => x.text), ['好的']);
  assert.equal(splitBySpeaker({ sentence: { ...sentence, words: [] }, pcm: long, pcmStartMs: 0, book, diarize }).length, 1);
});

test('切口落在分句中间：整个分句给说得久的那个人（不切在词中间）', () => {
  const pcm = Buffer.alloc(9 * 32000);
  for (let s = 0; s < 9; s += 1) pcm.fill(s < 4 ? 5 : 2, s * 32000, (s + 1) * 32000);
  const book = createSpeakerBook({ embed, enrolled: () => ({ 我: axis(5) }) });
  const w = (a, b, text) => ({ startMs: a * 1000, endMs: b * 1000, text });
  // 分段说 4 秒换人，但“话，”其实是“我”这句的尾巴；“安全吗？”这一句大半是对方
  const words = [w(0, 1, '我先'), w(1, 2, '跟你'), w(2, 3.9, '说'), w(4, 4.4, '话，'), w(4.5, 5, '所有'), w(5, 7, '记录安全'), w(7, 8.5, '吗？')];
  const sentence = { startMs: 0, endMs: 8500, text: words.map((x) => x.text).join(''), words };
  const diarize = () => [{ start: 0, end: 4, speaker: 0 }, { start: 4, end: 9, speaker: 1 }];
  const parts = splitBySpeaker({ sentence, pcm, pcmStartMs: 0, book, diarize });
  assert.deepEqual(parts.map((x) => [x.speaker, x.text]), [['我', '我先跟你说话，'], ['说话人2', '所有记录安全吗？']]);
});

test('屏幕上的短名字', () => {
  assert.equal(shortWho('我'), '我');
  assert.equal(shortWho('说话人2'), '二号');
  assert.equal(shortWho('说话人10'), '十号');
  assert.equal(shortWho('说话人12'), '12号');
  assert.equal(shortWho('其他人'), '其他');
  assert.equal(shortWho(undefined), '');
});
