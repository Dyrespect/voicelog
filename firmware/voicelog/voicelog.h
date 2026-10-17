// 随身录音模式（CONFIG_VOICELOG_MODE）：一直录、一直传、从不说话。
//
// 录和传分开：
// - 录：AudioService 照常出 Opus 包（每包带采集时的开机毫秒，见 audio_service.cc），主循环拿到就塞进
//   PSRAM 队列（PushPacket，不碰网络、不阻塞）。没网、服务器连不上、刚开机还没联网，都照录。
// - 传：单独一个任务（UplinkTask）负责开通道、断了每 5 秒重连、把队列从旧到新发出去，发成功才出队。
//   网络卡住只卡这个任务，不影响录音、按键、屏幕。
// - 每 30 秒报一次状态（电量、信号、队列里攒了多少、丢了多少），服务端放进 /voice/health。
// 服务端：~/Desktop/随身录音/server（/voice/xiaozhi/ota/、/voice/xiaozhi/ws），按开机毫秒 + hello 里的 boot_ms 换算真实时间。
#ifndef VOICELOG_H
#define VOICELOG_H

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "protocols/protocol.h"
#include "voicelog_screen.h"

struct cJSON;

class Voicelog {
public:
    static Voicelog& GetInstance() {
        static Voicelog instance;
        return instance;
    }

    /** 开机就调：分配队列、读出“在录还是停着”、起上传任务（协议还没好时它先等着） */
    void Start();
    /** 激活完成、协议对象建好之后由主循环调一次 */
    void SetProtocol(Protocol* protocol);
    /** 主循环拿到的每个 Opus 包都交给这里；只做拷贝，不阻塞 */
    void PushPacket(std::unique_ptr<AudioStreamPacket> packet);

    bool IsRecording() const { return recording_.load(); }
    /**
     * 声纹页（戴敬力 10-17）：双击 BOOT 进入，能看到登记过的人。音量 − / + 上下选，单击录 15 秒，到点自己停。
     * 再双击退出。退出后录音开关还是进来之前那样。选「我」再说“我是戴敬力”，名字记在“我”上。
     */
    enum EnrollState { kEnrollNone = 0, kEnrollRecording, kEnrollWaiting, kEnrollOk, kEnrollFail };
    static constexpr int kEnrollSeconds = 15;
    void StartEnroll();
    int GetEnrollState() const { return enroll_state_.load(); }
    /** 结果页上按 A：收起结果页 */
    void ClearEnrollResult() { enroll_state_ = kEnrollNone; }
    bool InMenu() const { return menu_open_.load(); }
    void EnterMenu();
    void ExitMenu();
    void MoveMenu(int delta);
    void ConfirmMenu();

    // 电量用完：屏幕换成“电量用完了”，之后由板子让电源芯片关机（见 m5stack_stick_s3.cc）。
    // 开机时就这样的话，application.cc 不开 WiFi
    void ShowPowerOff() { power_off_ = true; }
    bool PowerOffPending() const { return power_off_.load(); }
    /** 板子每 5 秒报一次电池电压，跟着状态报给服务器（看掉电曲线用） */
    void SetBatteryMv(int mv) { battery_mv_ = mv; }
    /** 没有电压读数的板子（正辰 1.54）报电池 ADC 原始平均值 */
    void SetBatteryAdc(int adc) { battery_adc_ = adc; }

    // 省电（戴敬力 10-16：“能多用一会儿是一会儿”；30 秒“比较合理，不然点亮屏幕的时候体验可能会很差”）：
    // 用电池、屏幕熄着时 WiFi 整个关掉，攒 30 秒再连上传完、再关（照 LifeLog 先存后传）；
    // 亮屏、插着电、录声纹、没电关机前一直连着，跟以前一样实时。板子告诉这边屏幕和插电的状态
    void SetScreenOn(bool on) { screen_on_ = on; }
    void SetPlugged(bool on) { plugged_ = on; }
    /** 攒的都传完了（没电关机前等它） */
    bool Drained() const { return BacklogMs() <= 120; }
    /** A 键：开始 / 停止录音（存进 NVS，关机再开照旧） */
    void SetRecording(bool on);
    bool IsOnline() const { return online_.load(); }
    /** 服务端发来的 {"type":"voicelog",...}：今天录了多久、刚识别出来的字；snapshot=true 就截一张屏传回去 */
    void OnServerMessage(const cJSON* root);
    uint32_t BacklogMs() const;
    uint32_t DroppedMs() const { return dropped_ms_.load(); }
    /** 升级下载进度（application.cc 的 UpgradeFirmware 报，真实的已下 / 总大小）；-1 = 不在升级。屏幕显示“升级中”，不显示“连接中” */
    void SetUpgrade(int pct, const std::string& to = "");
    /** 第一帧磁带已经画进屏幕之后调一次（板子这时才开背光，免得先闪小智的白屏） */
    void SetFirstFrameHook(std::function<void()> hook) { first_frame_hook_ = std::move(hook); }

private:
    Voicelog() = default;
    static void UplinkTaskEntry(void* arg);
    void UplinkTask();
    void SendStatus(Protocol* protocol);
    void UpdateDisplay();

    // 队列：PSRAM 里的环形字节缓冲，一条记录 = [uint32 开机毫秒][uint16 长度][Opus]
    bool PeekLocked(uint32_t& timestamp, std::vector<uint8_t>& payload, size_t& record_size);
    void PopLocked(size_t record_size);
    void ReadBytesLocked(size_t offset, uint8_t* out, size_t n) const;
    void WriteBytesLocked(size_t offset, const uint8_t* in, size_t n);

    mutable std::mutex mutex_;
    uint8_t* ring_ = nullptr;
    size_t capacity_ = 0;
    size_t head_ = 0;  // 下一条写到哪
    size_t tail_ = 0;  // 最旧的一条从哪开始
    size_t used_ = 0;
    uint32_t packets_ = 0;
    uint32_t drops_ = 0;  // 满了丢最旧的次数（上传任务用来判断它看中的那条还在不在）

    std::atomic<Protocol*> protocol_{nullptr};
    std::atomic<bool> recording_{true};
    std::atomic<bool> online_{false};
    std::atomic<uint32_t> dropped_ms_{0};
    std::atomic<uint32_t> sent_packets_{0};
    std::atomic<uint32_t> reconnects_{0};
    TaskHandle_t task_ = nullptr;

    // 屏幕
    VoicelogScreen screen_;
    std::function<void()> first_frame_hook_;
    std::mutex stats_mutex_;
    int recorded_sec_ = -1;       // 今天录了多久（服务端算）
    int64_t recorded_at_ms_ = -1; // 什么时候收到的：之间在录就自己往上加，屏幕上每秒都在走
    std::string live_text_;
    std::string live_partial_;    // 正在说的这句
    int64_t live_at_ms_ = -1;
    std::string live_base_;       // 已经说完的那几句
    bool live_pending_ = false;   // 最后一句还没说完
    std::atomic<bool> snapshot_requested_{false};
    std::string last_who_;        // 上一句是谁说的（同一个人接着说就不再标名字）
    std::atomic<int> upgrade_pct_{-1};
    std::string upgrade_to_;
    std::atomic<int> enroll_state_{kEnrollNone};
    std::atomic<bool> power_off_{false};
    std::atomic<bool> screen_on_{true};
    std::atomic<bool> plugged_{false};
    bool WantLive() const;
    std::atomic<int> battery_mv_{-1};
    std::atomic<int> battery_adc_{-1};
    int64_t enroll_start_ms_ = 0;
    int64_t enroll_waiting_since_ = 0;
    std::string enroll_reason_;
    std::atomic<bool> enroll_start_pending_{false};
    std::atomic<bool> enroll_end_pending_{false};
    std::atomic<bool> enroll_cancel_pending_{false};
    std::atomic<bool> menu_open_{false};
    std::atomic<bool> people_ask_pending_{false};
    struct MenuPerson {
        std::string id;
        std::string label;
        bool enrolled = false;
    };
    std::vector<MenuPerson> people_;
    int menu_index_ = 0;
    std::string menu_hint_;
    std::string enroll_slot_ = "我";
    void EnsurePeople();
    void ApplyPeople(const cJSON* arr, const std::string& prefer);
    void SendSnapshot(Protocol* protocol);
};

#endif  // VOICELOG_H
