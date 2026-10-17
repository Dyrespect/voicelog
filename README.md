# 随身录音

出门不用记。跟人正常聊，这块小屏一直在听。回来打开今天的文字，每句都有时间，谁说的也能分开。原始声音不留，云上只存字。

它不是手机里的录音 App。开机就录，不用打开，不用盯着屏幕。屏幕做成一台磁带，平时几乎关着，只在给人看的时候打开。

<p align="center">
  <img src="screens/recording.png" width="360" alt="录音中：顶上 REC，磁带，今天录了多久，底下是刚说的那句">
</p>

硬件是买来就焊好的正辰 1.54 寸方屏，ESP32-S3，16MB 闪存，8MB 内存。大约六七十块。三个键：单击 BOOT 开始或停止，双击进声纹名单，长按进联网设置。音量键平时调亮度、开关屏幕；进了声纹页就只用来上下选人。

## 它怎么干活

板子上把声音压成 Opus，一帧 60 毫秒，先放进内存。有 WiFi 就推到自己的服务器。服务器解开声音，先判断有没有人在说话，没人的段落不送去识别。有人说话才交给阿里百炼转写。每句话按板子上的时间对上真实时间，按天存成三份文字：句子、这段对话的小标题、每台板子录了多久。

声纹单独放。登记过的人在 sqlite 里一个人一行，空表不能把已经有的人盖掉。没登记的人只在这一场对话里编号，隔大约 5 分钟没说话就算下一场，不写进库。说「我是谁」，名字会补在「我」上面。

屏幕关着、又没插电的时候，它大约每 30 秒连一次，把攒下的传完，然后自己把 WiFi 关掉。这是省电。插着电就一直连着。旁边完全没有记住的 WiFi 时，板子里大约只能留最近 25 分钟，再久就把最早的丢掉，新的还在录。熄屏续航实测过一次，6 小时 35 分。重启或者升级的那几十秒里，还没传走的会丢。

出门没有电话卡，靠随身热点。旁边没有热点，就先存在机器里，回到有网的地方再补传。

## 和钉钉那张卡

钉钉 A1 Pro 官方价 1299，他们写连续录音 180 小时，还能给手机充电，录音进钉钉听记，再出纪要、待办、翻译。更早的 A1 青春版 499、旗舰版 799，是另一张卡。

这块板子干的是同一件核心的事：随身听着，回来是分好谁在说话的文字。没有他们的电话录音、实时翻译、待办进办公软件、64G 声音文件，也没有 180 小时续航。贵的是壳和会员。这里是一块现成的板子，画面、转写和声纹都在这个仓库里。

## 每一屏

屏是 240×240，黑底。中文用宋体，英文和数字用等宽字。顶上那排只有 REC、STOP 这种拉丁词，因为那套字只有英文。底下两行是状态。声纹页把磁带拿开，中间是名单。

| 开机 | 连接中 | 录音中 |
| --- | --- | --- |
| <img src="screens/boot.png" width="220" alt="开机"> | <img src="screens/connecting.png" width="220" alt="连接中"> | <img src="screens/recording.png" width="220" alt="录音中"> |
| 通电后先亮这一屏，版本号是板子上真装的那个。取代小智原来的白屏。 | 正在连 WiFi 和服务器。这时候已经在录，先存在机器里，时间是真的在涨。 | 平时就是这一屏。左下是今天录了多久，右下是麦克风音量，底下是刚说的那句。 |

| 没网 | 补传 | 已停止 |
| --- | --- | --- |
| <img src="screens/offline.png" width="220" alt="没网"> | <img src="screens/upload.png" width="220" alt="补传"> | <img src="screens/stopped.png" width="220" alt="已停止"> |
| 路上没信号。照样在录，存在机器里，有网了自己补传。 | 刚连上，把存着的那段发出去。传完，字幕就接着出来。 | 单击 BOOT 停下。磁带不转。插着电的时候，电量格子一格格往上走。 |

| 声纹名单 | 录声纹 | 升级中 |
| --- | --- | --- |
| <img src="screens/people.png" width="220" alt="声纹名单"> | <img src="screens/enroll.png" width="220" alt="录声纹"> | <img src="screens/update.png" width="220" alt="升级中"> |
| 双击 BOOT。音量键上下选，可以一直新增。录过的右边写「已录」。 | 在名单里单击。倒计时到 0 自己停。记上之后写「录好了」，没听清就写「没听清」。 | 有新版本时自己下载。左下是真进度。下完重启，连不上服务器会退回旧的。 |

| 联网设置 | 电量低 |
| --- | --- |
| <img src="screens/setup.png" width="220" alt="联网设置"> | <img src="screens/sleep.png" width="220" alt="电量低"> |
| 长按 BOOT。手机连上板子自己的热点，打开上面的网址，把 WiFi 写进去。最多记 10 个。 | 电量到 10% 停录，把攒的传完，然后深睡，不把电放干。插电或按 BOOT 醒来，接着录。 |

动的稿子在 [`design/各状态屏_初稿.html`](design/各状态屏_初稿.html)，用浏览器打开。录音中那一屏单独的定稿是 [`design/录音中一屏_定稿.html`](design/录音中一屏_定稿.html)。磁带、灯、滚轮、VU 的零件在 `design/固件素材/png/`。字和图怎么进固件，写在 [`design/固件素材/README.md`](design/固件素材/README.md)。

## 仓库里有什么

`server/` 是服务器，Node 22。入口是 `server/src/server.mjs`。板子协议在 `xiaozhi.mjs`，转写在 `asr.mjs` 和 `transcriber.mjs`，有没有人说话在 `gate.mjs` 和 `vad.mjs`，声纹在 `speakers.mjs` 和 `printsStore.mjs`，按天存字在 `daylog.mjs`，对话标题在 `convs.mjs`。拉下来看某一天：`node pull.mjs 今天`。

`firmware/voicelog/` 是板子上的录音和屏幕，画在 `voicelog_screen.cc`。它不是一份能单独编译的工程，要放进 [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32)，板型 `voicelog-zhengchen-1.54`。WiFi 密码和设备令牌不在仓库里。

密钥放环境变量，样例是 [`.env.example`](.env.example)。声纹模型不放进仓库，三个文件大约 35MB，放到 `server/models/`：`campplus_zh.onnx`、`segmentation.onnx`、`silero_vad.onnx`。

```bash
cd server
cp ../.env.example .env
npm ci
npm test
npm start
```

转写走阿里百炼，按量算。文字存在腾讯云 COS 的 `voicelog/` 前缀。只有登记过的板子能领到连接地址。
