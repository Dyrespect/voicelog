# 随身录音

一块 1.54 寸的小屏，开机就录。说的话变成带时间的文字。原始声音不留。

硬件是买来焊好的正辰 ESP32-S3 方屏，大约六七十块。出门靠 WiFi，没有电话卡。屏幕关着、没插电时，大约每 30 秒连一次把攒的传完。完全没网时，板子里大约留最近 25 分钟。熄屏续航实测过一次：6 小时 35 分。

## 每一屏

各状态画在一张页面里，用浏览器打开 [`design/各状态屏_初稿.html`](design/各状态屏_初稿.html)。

开机、连接中、录音中、没网、补传、已停止、声纹名单、录声纹、升级中、联网设置、电量低先睡了，都在这一页。录音中那一屏的定稿是 [`design/录音中一屏_定稿.html`](design/录音中一屏_定稿.html)。磁带、灯、滚轮、VU 的零件图在 `design/固件素材/png/`。

屏幕是 240×240，黑底。中文用宋体，英文和数字用等宽字。声纹页把磁带拿开，中间是名单。

## 仓库里有什么

- `server/`：收 Opus、判断有没有人说话、转写、声纹、按天存文字。Node 22。密钥放在环境变量里，样例是 [`.env.example`](.env.example)。
- `firmware/voicelog/`：板子上的录音和屏幕代码，要嵌进 [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) 才能编。
- `design/`：屏幕稿。

声纹模型（CAM++、说话人分段、Silero VAD）不放在仓库里。放到 `server/models/`，文件名是 `campplus_zh.onnx`、`segmentation.onnx`、`silero_vad.onnx`。

```bash
cd server
cp ../.env.example .env
npm ci
npm test
npm start
```

转写用阿里百炼，文字存在腾讯云 COS 的 `voicelog/` 前缀。声纹一个人一行，写在 `VOICELOG_DB` 指向的 sqlite。空表不能覆盖已经有人的库。
