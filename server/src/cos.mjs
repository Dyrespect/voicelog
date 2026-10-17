import COS from 'cos-nodejs-sdk-v5';

/** 腾讯云 COS 读写文本。只用得到“整份读”和“整份写”。 */
export function createCos({ secretId, secretKey, bucket, region }) {
  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });
  return {
    /** 没有这个文件时返回 null */
    async getText(key) {
      try {
        const res = await cos.getObject({ Bucket: bucket, Region: region, Key: key });
        return res.Body.toString('utf8');
      } catch (err) {
        if (err?.statusCode === 404 || err?.code === 'NoSuchKey') return null;
        throw err;
      }
    },
    async putText(key, text, contentType = 'application/x-ndjson; charset=utf-8') {
      await cos.putObject({ Bucket: bucket, Region: region, Key: key, Body: Buffer.from(text, 'utf8'), ContentType: contentType });
    },
    async list(prefix) {
      const res = await cos.getBucket({ Bucket: bucket, Region: region, Prefix: prefix, MaxKeys: 1000 });
      return res.Contents.map((c) => ({ key: c.Key, size: Number(c.Size), modified: c.LastModified }));
    },
  };
}
