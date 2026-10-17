# 随身录音

一块 1.54 寸的小屏。开机就录，回来是带时间的文字。声音不留。

<p align="center">
  <img src="screens/recording.png" width="360" alt="录音中">
</p>

## 每一屏

屏幕是 240×240。黑底，磁带，中文宋体，英文和数字等宽。下面这些就是板子上会看到的。

| 开机 | 连接中 | 录音中 |
| --- | --- | --- |
| <img src="screens/boot.png" width="220" alt="开机"> | <img src="screens/connecting.png" width="220" alt="连接中"> | <img src="screens/recording.png" width="220" alt="录音中"> |
| 通电后先看到这一屏 | 已经在录，先存在机器里 | 平时就是这一屏 |

| 没网 | 补传 | 已停止 |
| --- | --- | --- |
| <img src="screens/offline.png" width="220" alt="没网"> | <img src="screens/upload.png" width="220" alt="补传"> | <img src="screens/stopped.png" width="220" alt="已停止"> |
| 路上没信号，照样在录 | 刚连上，把攒的发出去 | 单击 BOOT 停下。插着电 |

| 声纹名单 | 录声纹 | 升级中 |
| --- | --- | --- |
| <img src="screens/people.png" width="220" alt="声纹名单"> | <img src="screens/enroll.png" width="220" alt="录声纹"> | <img src="screens/update.png" width="220" alt="升级中"> |
| 双击 BOOT。音量键上下选 | 单击开始，到点自己停 | 下载的时候别关机 |

| 联网设置 | 电量低 |
| --- | --- |
| <img src="screens/setup.png" width="220" alt="联网设置"> | <img src="screens/sleep.png" width="220" alt="电量低"> |
| 长按 BOOT，手机连这个热点 | 到 10% 先睡，插电或按 BOOT 醒来 |

稿子还在 [`design/各状态屏_初稿.html`](design/各状态屏_初稿.html)，用浏览器打开能看动的。录音中那一屏的定稿是 [`design/录音中一屏_定稿.html`](design/录音中一屏_定稿.html)。

## 这块东西

现成焊好的正辰 ESP32-S3 方屏，大约六七十块。出门靠 WiFi，没有电话卡。屏幕关着、没插电时，大约每 30 秒连一次，传完再把 WiFi 关掉。完全没网时，板子里大约留最近 25 分钟。熄屏续航实测过一次，6 小时 35 分。

- `server/`：收声音、判断有没有人在说话、转写、声纹、按天存文字。
- `firmware/voicelog/`：板子上的录音和屏幕。要放进 [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) 才能编。
- 密钥放环境变量，样例是 [`.env.example`](.env.example)。声纹模型不在仓库里。

```bash
cd server
cp ../.env.example .env
npm ci
npm test
npm start
```
