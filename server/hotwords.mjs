// 把 hotwords.txt 建成 / 更新成百炼热词表（paraformer-realtime-v2 用）。热词免费。
// 用法：node hotwords.mjs          （密钥读 DASHSCOPE_API_KEY，没有就读 VOICELOG_ENV 指的文件）
// 第一次：建表，打印 vocabulary_id → 填进服务器 /opt/voicelog/.env 的 ASR_VOCABULARY_ID，重启服务。
// 以后：环境里有 ASR_VOCABULARY_ID 就是更新那张表（改完马上生效，不用重启）。
import fs from 'node:fs';

const envFile = process.env.VOICELOG_ENV;
const fileEnv = {};
if (envFile && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) fileEnv[m[1]] = m[2];
  }
}
const get = (k) => process.env[k] || fileEnv[k];
const apiKey = get('DASHSCOPE_API_KEY');
const vocabId = get('ASR_VOCABULARY_ID');
if (!apiKey) { console.error('缺 DASHSCOPE_API_KEY'); process.exit(2); }

const words = fs.readFileSync(new URL('./hotwords.txt', import.meta.url), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const vocabulary = words.map((text) => ({ text, weight: 4, lang: /[一-鿿]/.test(text) ? 'zh' : 'en' }));

const input = vocabId
  ? { action: 'update_vocabulary', vocabulary_id: vocabId, vocabulary }
  : { action: 'create_vocabulary', target_model: 'paraformer-realtime-v2', prefix: 'voicelog', vocabulary };
const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/audio/asr/customization', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'speech-biasing', input }),
});
const data = await res.json();
if (!res.ok) { console.error('失败', res.status, JSON.stringify(data)); process.exit(1); }
console.log(vocabId ? `更新了 ${vocabId}（${words.length} 个词）` : `建好了：ASR_VOCABULARY_ID=${data.output.vocabulary_id}（${words.length} 个词）`);
