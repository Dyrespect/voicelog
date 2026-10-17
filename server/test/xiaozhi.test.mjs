// 板子型号和名字（远程升级按型号分开，免得把 StickS3 的固件推给正辰 1.54）
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardOf, deviceName } from '../src/xiaozhi.mjs';

test('型号从 User-Agent 来；没带或乱的算 StickS3', () => {
  assert.equal(boardOf('voicelog-zhengchen-1.54/2.8.0'), 'voicelog-zhengchen-1.54');
  assert.equal(boardOf('voicelog-stick-s3/2.7.8'), 'voicelog-stick-s3');
  assert.equal(boardOf(undefined), 'voicelog-stick-s3');
  assert.equal(boardOf('../../etc/passwd/1'), 'voicelog-stick-s3');
});

test('名字：StickS3 还叫 stick-xxxx，正辰叫 zc-xxxx', () => {
  assert.equal(deviceName(undefined, '7c:e8:b1:e5:43:14'), 'stick-4314');
  assert.equal(deviceName('voicelog-stick-s3/2.7.8', '7c:e8:b1:e5:43:14'), 'stick-4314');
  assert.equal(deviceName('voicelog-zhengchen-1.54/2.8.0', '02:00:00:00:11:22'), 'zc-1122');
});
