#include "voicelog.h"

#include <esp_app_desc.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <wifi_manager.h>

#include <cJSON.h>
#include <algorithm>
#include <cstdio>
#include <cstring>

#include <mbedtls/base64.h>

#include "application.h"
#include "board.h"
#include "display/display.h"
#include "settings.h"

#define TAG "Voicelog"

namespace {
constexpr size_t kHeader = 6;            // uint32 开机毫秒 + uint16 长度
constexpr int kFrameMs = 60;             // Opus 一帧 60ms（OPUS_FRAME_DURATION_MS）
constexpr int64_t kRetryMs = 5000;       // 连不上服务器，隔多久再试
constexpr int64_t kStatusMs = 30000;     // 多久报一次状态
constexpr int kSendBatch = 30;           // 一圈最多发多少包（补传时约 30 倍速）

// 熄屏攒着发（见 voicelog.h）
constexpr int64_t kBatchMs = 30000;        // 熄屏时多久连一次（戴敬力 10-16 定 30 秒）
constexpr int64_t kWakeTimeoutMs = 20000;  // 醒来这么久还没连上服务器：先关 WiFi，下一轮再试（没网时也不一直扫）
constexpr int64_t kQuietMs = 1000;         // 断开前要有这么久没人说话，免得一句话切成两半
constexpr int64_t kMaxExtraMs = 30000;     // 一直有人说话：传完以后最多再连这么久，到点照样断

int64_t NowMs() { return esp_timer_get_time() / 1000; }

void SetMic(bool on) {
    Application::GetInstance().Schedule([on]() {
        Application::GetInstance().GetAudioService().EnableVoiceProcessing(on);
    });
}
}  // namespace

bool Voicelog::WantLive() const {
    const int e = enroll_state_.load();
    return screen_on_ || plugged_ || power_off_ || menu_open_ || e == kEnrollRecording || e == kEnrollWaiting ||
           enroll_start_pending_ || enroll_end_pending_ || enroll_cancel_pending_ || people_ask_pending_ ||
           snapshot_requested_;
}

void Voicelog::Start() {
    // 能给多大给多大：配置的大小，但给界面、网络留 1.5MB（10-16 正辰 1.54 要 6MB 没要到，退成了 512KB）
    const size_t want = (size_t)CONFIG_VOICELOG_BACKLOG_KB * 1024;
    const size_t largest = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
    const size_t reserve = 1536 * 1024;
    capacity_ = std::min(want, largest > reserve ? largest - reserve : (size_t)0);
    if (capacity_ < 512 * 1024) capacity_ = 512 * 1024;  // 最少 512KB（约 4 分钟），总比没有强
    ring_ = (uint8_t*)heap_caps_malloc(capacity_, MALLOC_CAP_SPIRAM);
    if (ring_ == nullptr) {
        capacity_ = 512 * 1024;
        ring_ = (uint8_t*)heap_caps_malloc(capacity_, MALLOC_CAP_SPIRAM);
    }
    ESP_LOGI(TAG, "队列 %u KB（PSRAM 最大块 %u KB）", (unsigned)(ring_ ? capacity_ / 1024 : 0), (unsigned)(largest / 1024));

    Settings settings("voicelog", false);
    recording_ = settings.GetInt("paused", 0) == 0;

    xTaskCreate(UplinkTaskEntry, "voicelog_up", 8192, this, 3, &task_);
    // 屏幕单独一个任务每秒刷一次：上传任务连服务器时会卡十来秒，不能让屏幕跟着停
    // 栈给足：建 LVGL 控件、量文字宽度很吃栈（4KB 时 2.6.3 开机就崩、一直重启闪屏）。
    // 第一帧还要在这个任务里把整屏刷进面板（lv_refr_now），再多留一点。
    // VU 指针用的麦克风音量
    screen_.SetLevelSource([]() { return Application::GetInstance().GetAudioService().GetInputLevelDb(); });
    // 我们的界面用自己的字体和图，不等小智的字库：一开机就换成我们的开机屏
    xTaskCreate(
        [](void* arg) {
            while (true) {
                static_cast<Voicelog*>(arg)->UpdateDisplay();
                vTaskDelay(pdMS_TO_TICKS(250));  // 边说边出字要跟得上
            }
        },
        "voicelog_ui", 16384, this, 2, nullptr);
}

void Voicelog::SetProtocol(Protocol* protocol) { protocol_.store(protocol); }

void Voicelog::SetUpgrade(int pct, const std::string& to) {
    if (!to.empty()) {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        upgrade_to_ = to;
    }
    upgrade_pct_ = pct;
}

void Voicelog::SetRecording(bool on) {
    recording_ = on;
    Settings settings("voicelog", true);
    settings.SetInt("paused", on ? 0 : 1);
    ESP_LOGI(TAG, "%s", on ? "开始录音" : "停止录音");
}

uint32_t Voicelog::BacklogMs() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return packets_ * kFrameMs;
}

void Voicelog::ReadBytesLocked(size_t offset, uint8_t* out, size_t n) const {
    const size_t first = std::min(n, capacity_ - offset);
    memcpy(out, ring_ + offset, first);
    if (first < n) memcpy(out + first, ring_, n - first);
}

void Voicelog::WriteBytesLocked(size_t offset, const uint8_t* in, size_t n) {
    const size_t first = std::min(n, capacity_ - offset);
    memcpy(ring_ + offset, in, first);
    if (first < n) memcpy(ring_, in + first, n - first);
}

bool Voicelog::PeekLocked(uint32_t& timestamp, std::vector<uint8_t>& payload, size_t& record_size) {
    if (packets_ == 0) return false;
    uint8_t hdr[kHeader];
    ReadBytesLocked(tail_, hdr, kHeader);
    timestamp = (uint32_t)hdr[0] | ((uint32_t)hdr[1] << 8) | ((uint32_t)hdr[2] << 16) | ((uint32_t)hdr[3] << 24);
    const size_t len = (size_t)hdr[4] | ((size_t)hdr[5] << 8);
    payload.resize(len);
    ReadBytesLocked((tail_ + kHeader) % capacity_, payload.data(), len);
    record_size = kHeader + len;
    return true;
}

void Voicelog::PopLocked(size_t record_size) {
    tail_ = (tail_ + record_size) % capacity_;
    used_ -= record_size;
    packets_ -= 1;
}

void Voicelog::EnsurePeople() {
    if (!people_.empty()) return;
    people_.push_back({"我", "我"});
    people_.push_back({"", "新增"});
}

void Voicelog::ApplyPeople(const cJSON* arr, const std::string& prefer) {
    std::vector<MenuPerson> next;
    bool saw_me = false;
    bool saw_new = false;
    for (cJSON* item = arr ? const_cast<cJSON*>(arr)->child : nullptr; item; item = item->next) {
        const cJSON* idj = cJSON_GetObjectItem(item, "id");
        const cJSON* namej = cJSON_GetObjectItem(item, "name");
        std::string id = cJSON_IsString(idj) ? idj->valuestring : "";
        std::string name = cJSON_IsString(namej) ? namej->valuestring : "";
        MenuPerson person;
        if (id == "我") {
            saw_me = true;
            person.id = "我";
            person.label = name.empty() ? "我" : ("我 " + name);
            person.enrolled = cJSON_IsTrue(cJSON_GetObjectItem(item, "enrolled"));
        } else if (id.empty() || name == "新增") {
            if (saw_new) continue;
            saw_new = true;
            person.id = "";
            person.label = "新增";
        } else {
            person.id = id;
            person.label = name.empty() ? id : name;
            person.enrolled = !cJSON_IsFalse(cJSON_GetObjectItem(item, "enrolled"));
        }
        next.push_back(std::move(person));
    }
    if (!saw_me) next.insert(next.begin(), {"我", "我"});
    if (!saw_new) next.push_back({"", "新增"});
    std::string keep = prefer;
    if (keep.empty() && menu_index_ >= 0 && menu_index_ < (int)people_.size()) keep = people_[menu_index_].id;
    people_ = std::move(next);
    menu_index_ = 0;
    for (int i = 0; i < (int)people_.size(); i++) {
        if (people_[i].id == keep) {
            menu_index_ = i;
            break;
        }
    }
}

void Voicelog::EnterMenu() {
    if (menu_open_) return;
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        EnsurePeople();
        menu_index_ = 0;
        menu_hint_.clear();
    }
    menu_open_ = true;
    people_ask_pending_ = true;
    // 名单上不进对话。麦克风先关，点了某个人再开。
    SetMic(false);
    ESP_LOGI(TAG, "进入声纹名单");
}

void Voicelog::ExitMenu() {
    if (!menu_open_) return;
    const int state = enroll_state_.load();
    if (state == kEnrollRecording || state == kEnrollWaiting) {
        enroll_cancel_pending_ = true;
        enroll_start_pending_ = false;
        enroll_end_pending_ = false;
        enroll_state_ = kEnrollNone;
    }
    menu_open_ = false;
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        menu_hint_.clear();
    }
    // 录音开关没改过：进来之前在录，出去接着录
    SetMic(recording_.load());
    ESP_LOGI(TAG, "离开声纹名单");
}

void Voicelog::MoveMenu(int delta) {
    if (!menu_open_) return;
    const int state = enroll_state_.load();
    if (state == kEnrollRecording || state == kEnrollWaiting) return;
    std::lock_guard<std::mutex> lock(stats_mutex_);
    if (people_.empty()) EnsurePeople();
    const int n = (int)people_.size();
    menu_index_ = (menu_index_ + delta + n) % n;
    menu_hint_.clear();
}

void Voicelog::ConfirmMenu() {
    if (!menu_open_ || enroll_state_ != kEnrollNone) return;
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        if (people_.empty()) EnsurePeople();
        if (menu_index_ < 0 || menu_index_ >= (int)people_.size()) menu_index_ = 0;
        enroll_slot_ = people_[menu_index_].id;
        menu_hint_.clear();
    }
    StartEnroll();
}

void Voicelog::StartEnroll() {
    if (enroll_state_ == kEnrollRecording) return;
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        // 不在名单里直接录（老的双击）才默认“我”。新增的 id 是空的，要留着。
        if (enroll_slot_.empty() && !menu_open_) enroll_slot_ = "我";
    }
    enroll_start_ms_ = NowMs();
    enroll_state_ = kEnrollRecording;
    enroll_start_pending_ = true;
    enroll_cancel_pending_ = false;
    SetMic(true);
    ESP_LOGI(TAG, "开始录声纹 %d 秒", kEnrollSeconds);
}

void Voicelog::PushPacket(std::unique_ptr<AudioStreamPacket> packet) {
    if (ring_ == nullptr || !packet || packet->payload.empty()) return;
    // 声纹页上只有正在录的那 15 秒进队列，选人时说的话不进对话
    if (menu_open_ && enroll_state_ != kEnrollRecording) return;
    if (!recording_ && enroll_state_ != kEnrollRecording) return;
    if (power_off_) return;  // 要关机了：不再攒，把攒的传完
    const size_t len = packet->payload.size();
    const size_t need = kHeader + len;
    if (len > 0xFFFF || need > capacity_) return;

    std::lock_guard<std::mutex> lock(mutex_);
    // 满了丢最旧的（没网太久）；上传任务那边靠 drops_ 知道它看中的那条没了
    while (capacity_ - used_ < need && packets_ > 0) {
        uint8_t hdr[kHeader];
        ReadBytesLocked(tail_, hdr, kHeader);
        PopLocked(kHeader + ((size_t)hdr[4] | ((size_t)hdr[5] << 8)));
        dropped_ms_ += kFrameMs;
        drops_ += 1;
    }
    const uint32_t ts = packet->timestamp;
    const uint8_t hdr[kHeader] = {(uint8_t)ts, (uint8_t)(ts >> 8), (uint8_t)(ts >> 16), (uint8_t)(ts >> 24),
                                  (uint8_t)len, (uint8_t)(len >> 8)};
    WriteBytesLocked(head_, hdr, kHeader);
    WriteBytesLocked((head_ + kHeader) % capacity_, packet->payload.data(), len);
    head_ = (head_ + need) % capacity_;
    used_ += need;
    packets_ += 1;
}

void Voicelog::UplinkTaskEntry(void* arg) { static_cast<Voicelog*>(arg)->UplinkTask(); }

void Voicelog::UplinkTask() {
    std::vector<uint8_t> payload;
    int64_t last_try = -kRetryMs;
    int64_t last_status = 0;
    bool was_open = false;
    // 熄屏攒着发
    bool parked = false;          // WiFi 是这里关的
    int64_t parked_at = 0;
    int64_t awake_at = NowMs();   // 这一轮醒来的时间
    int64_t caught_up_at = -1;    // 这一轮第一次传完的时间
    int64_t last_voice = 0;       // 最后一次听到有人说话

    while (true) {
        const int64_t now = NowMs();
        auto& wifi = WifiManager::GetInstance();
        if (Application::GetInstance().GetAudioService().IsVoiceDetected()) last_voice = now;
        const bool live = WantLive();

        if (parked) {
            if (!live && !(now - parked_at >= kBatchMs && BacklogMs() > 0)) {
                vTaskDelay(pdMS_TO_TICKS(200));
                continue;
            }
            ESP_LOGI(TAG, "开 WiFi（%s，攒了 %u 秒）", live ? "要实时" : "到点了", (unsigned)(BacklogMs() / 1000));
            wifi.StartStation();
            parked = false;
            awake_at = now;
            caught_up_at = -1;
            last_try = -kRetryMs;  // WiFi 一连上马上连服务器
        }

        Protocol* protocol = protocol_.load();
        if (protocol == nullptr) {
            // 开机还没联网激活：照旧一直连着找网，不关 WiFi
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }

        auto park = [&](const char* why) {
            if (protocol->IsAudioChannelOpened()) protocol->CloseAudioChannel(false);
            wifi.StopStation();
            parked = true;
            parked_at = NowMs();
            online_ = false;
            was_open = false;
            ESP_LOGI(TAG, "关 WiFi（%s），%d 秒后再连", why, (int)(kBatchMs / 1000));
        };

        if (!protocol->IsAudioChannelOpened()) {
            if (!live && now - awake_at > kWakeTimeoutMs) {
                park("没连上");
                continue;
            }
            if (was_open) {
                ESP_LOGW(TAG, "和服务器的连接断了，声音先攒着");
                was_open = false;
                online_ = false;
            }
            if (now - last_try < kRetryMs || !WifiManager::GetInstance().IsConnected()) {
                vTaskDelay(pdMS_TO_TICKS(200));
                continue;
            }
            last_try = now;
            ESP_LOGI(TAG, "连服务器（队列里有 %u 秒）", (unsigned)(BacklogMs() / 1000));
            protocol->CloseAudioChannel(false);
            if (!protocol->OpenAudioChannel()) {
                ESP_LOGW(TAG, "没连上，%d 秒后再试", (int)(kRetryMs / 1000));
                continue;
            }
            reconnects_ += 1;
            was_open = true;
            online_ = true;
            last_status = 0;
        }

        if (now - last_status > kStatusMs) {
            SendStatus(protocol);
            last_status = now;
        }
        if (snapshot_requested_.exchange(false)) {
            SendSnapshot(protocol);
        }
        auto send_obj = [&](cJSON* root) {
            char* text = cJSON_PrintUnformatted(root);
            cJSON_Delete(root);
            if (text == nullptr) return;
            protocol->SendJson(text);
            cJSON_free(text);
        };
        if (enroll_cancel_pending_.exchange(false)) {
            enroll_start_pending_ = false;
            enroll_end_pending_ = false;
            cJSON* root = cJSON_CreateObject();
            cJSON_AddStringToObject(root, "type", "enroll_cancel");
            cJSON_AddNumberToObject(root, "boot_ms", (double)NowMs());
            send_obj(root);
        }
        if (enroll_start_pending_.exchange(false)) {
            std::string slot;
            {
                std::lock_guard<std::mutex> lock(stats_mutex_);
                slot = enroll_slot_;
            }
            cJSON* root = cJSON_CreateObject();
            cJSON_AddStringToObject(root, "type", "enroll");
            cJSON_AddStringToObject(root, "name", slot.c_str());
            cJSON_AddNumberToObject(root, "seconds", kEnrollSeconds);
            cJSON_AddNumberToObject(root, "start_ms", (double)enroll_start_ms_);
            cJSON_AddNumberToObject(root, "boot_ms", (double)NowMs());
            send_obj(root);
        }
        if (enroll_end_pending_.exchange(false)) {
            cJSON* root = cJSON_CreateObject();
            cJSON_AddStringToObject(root, "type", "enroll_end");
            cJSON_AddNumberToObject(root, "boot_ms", (double)NowMs());
            send_obj(root);
        }
        if (people_ask_pending_.exchange(false)) {
            cJSON* root = cJSON_CreateObject();
            cJSON_AddStringToObject(root, "type", "people");
            cJSON_AddNumberToObject(root, "boot_ms", (double)NowMs());
            send_obj(root);
        }

        int sent = 0;
        while (sent < kSendBatch) {
            uint32_t ts = 0;
            size_t record_size = 0;
            uint32_t drops_at_peek = 0;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (!PeekLocked(ts, payload, record_size)) break;
                drops_at_peek = drops_;
            }
            auto packet = std::make_unique<AudioStreamPacket>();
            packet->sample_rate = 16000;
            packet->frame_duration = kFrameMs;
            packet->timestamp = ts;
            packet->payload = payload;
            if (!protocol->SendAudio(std::move(packet))) {
                ESP_LOGW(TAG, "发不出去，断开重连");
                protocol->CloseAudioChannel(false);
                online_ = false;
                was_open = false;
                break;
            }
            {
                std::lock_guard<std::mutex> lock(mutex_);
                // 发的时候队列满了把这条当最旧的丢了：别再出队，免得把下一条没发的也删掉
                if (drops_ == drops_at_peek) PopLocked(record_size);
            }
            sent += 1;
            sent_packets_ += 1;
        }
        // 熄屏：传完了、刚好没人说话（或者一直有人说、已经多连了 30 秒）就关 WiFi
        if (!live && was_open && Drained()) {
            if (caught_up_at < 0) caught_up_at = now;
            if (now - last_voice >= kQuietMs || now - caught_up_at >= kMaxExtraMs) {
                park(now - last_voice >= kQuietMs ? "传完了" : "一直有人说话，到点断");
                continue;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(sent == 0 ? 30 : 1));
    }
}

void Voicelog::SendStatus(Protocol* protocol) {
    auto& board = Board::GetInstance();
    int level = -1;
    bool charging = false;
    bool discharging = false;
    board.GetBatteryLevel(level, charging, discharging);
    auto& wifi = WifiManager::GetInstance();

    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "status");
    cJSON_AddNumberToObject(root, "boot_ms", (double)NowMs());
    cJSON_AddStringToObject(root, "fw", esp_app_get_description()->version);
    cJSON_AddBoolToObject(root, "recording", recording_.load());
    cJSON_AddNumberToObject(root, "backlogSec", BacklogMs() / 1000);
    cJSON_AddNumberToObject(root, "droppedSec", dropped_ms_.load() / 1000);
    cJSON_AddNumberToObject(root, "sentPackets", sent_packets_.load());
    cJSON_AddNumberToObject(root, "netResets", reconnects_.load() > 0 ? reconnects_.load() - 1 : 0);
    cJSON_AddNumberToObject(root, "bat", level);
    cJSON_AddNumberToObject(root, "vbat", battery_mv_.load());
    if (battery_adc_.load() >= 0) cJSON_AddNumberToObject(root, "batAdc", battery_adc_.load());
    cJSON_AddBoolToObject(root, "charging", charging);
    cJSON_AddStringToObject(root, "ssid", wifi.GetSsid().c_str());
    cJSON_AddNumberToObject(root, "rssi", wifi.GetRssi());
    cJSON_AddNumberToObject(root, "heap", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(root, "psram", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    // 上次为什么重启（1 上电 3 软件 4 崩溃 5 中断看门狗 6 任务看门狗 7 其他看门狗 9 掉电…，esp_reset_reason）
    cJSON_AddNumberToObject(root, "resetReason", (int)esp_reset_reason());
    char* text = cJSON_PrintUnformatted(root);
    protocol->SendJson(text);
    cJSON_free(text);
    cJSON_Delete(root);
}

void Voicelog::OnServerMessage(const cJSON* root) {
    auto get_int = [root](const char* key, int dflt) {
        const cJSON* item = cJSON_GetObjectItem(root, key);
        return cJSON_IsNumber(item) ? item->valueint : dflt;
    };
    auto get_str = [root](const char* key) {
        const cJSON* item = cJSON_GetObjectItem(root, key);
        return cJSON_IsString(item) ? std::string(item->valuestring) : std::string();
    };
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        if (cJSON_IsNumber(cJSON_GetObjectItem(root, "recordedSec"))) {
            recorded_sec_ = get_int("recordedSec", recorded_sec_);
            recorded_at_ms_ = NowMs();
        }
        // 刚识别出来的字：没说完的是这句到目前为止的全文；说完一句就留着它，下一句接在后面
        if (cJSON_IsString(cJSON_GetObjectItem(root, "live"))) {
            const std::string text = get_str("live");
            const bool final = cJSON_IsTrue(cJSON_GetObjectItem(root, "final"));
            if (!live_pending_) live_base_ = live_text_.empty() ? "" : live_text_;
            // 说完的句子带着是谁说的（服务端认的“我”“二号”）：换了人、或者隔了一阵才说，就在句子前面标一下
            std::string who = final ? get_str("who") : "";
            who.erase(std::remove_if(who.begin(), who.end(), [](char ch) { return ch == '\x1e' || ch == '\x1f'; }), who.end());
            const bool mark = !who.empty() && (who != last_who_ || live_at_ms_ < 0 || NowMs() - live_at_ms_ > 12000);
            if (!who.empty()) last_who_ = who;
            live_text_ = live_base_ + (mark ? "\x1e" + who + "\x1f" : std::string()) + text;
            live_partial_ = final ? "" : text;
            live_pending_ = !final;
            if (final) live_base_ = live_text_;
            if (live_text_.size() > 600) {
                // 太长就只留后面 300 字节，从完整的字开头切（不切半个汉字）
                size_t cut = live_text_.size() - 300;
                while (cut < live_text_.size() && (static_cast<unsigned char>(live_text_[cut]) & 0xC0) == 0x80) cut++;
                live_text_ = live_text_.substr(cut);
                if (!live_pending_) live_base_ = live_text_;
            }
            live_at_ms_ = NowMs();
        }
    }
    if (cJSON_IsTrue(cJSON_GetObjectItem(root, "snapshot"))) snapshot_requested_ = true;
    const cJSON* people = cJSON_GetObjectItem(root, "people");
    const cJSON* enroll = cJSON_GetObjectItem(root, "enroll");
    if (cJSON_IsArray(people) || cJSON_IsString(enroll)) {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        if (cJSON_IsArray(people)) ApplyPeople(people, get_str("id"));
        // 网慢时结果会晚到。名单还开着就收下，不要因为本地已经判过「没连上」就丢掉。
        if (cJSON_IsString(enroll) && (enroll_state_ == kEnrollWaiting || menu_open_)) {
            const bool ok = strcmp(enroll->valuestring, "ok") == 0;
            const std::string reason = ok ? "录好了" : (get_str("reason").empty() ? "没听清" : get_str("reason"));
            if (menu_open_) {
                menu_hint_ = reason;
                enroll_state_ = kEnrollNone;
            } else if (enroll_state_ == kEnrollWaiting) {
                enroll_reason_ = ok ? "" : reason;
                enroll_state_ = ok ? kEnrollOk : kEnrollFail;
            }
        }
    }
}

void Voicelog::SendSnapshot(Protocol* protocol) {
    auto display = Board::GetInstance().GetDisplay();
    std::string jpeg;
    std::string error;
    if (!screen_.SnapshotJpeg(display, jpeg, error)) {
        ESP_LOGW(TAG, "截屏失败：%s", error.c_str());
        protocol->SendJson("{\"type\":\"snapshot\",\"error\":\"" + error + "\"}");
        return;
    }
    size_t out_len = 0;
    mbedtls_base64_encode(nullptr, 0, &out_len, (const unsigned char*)jpeg.data(), jpeg.size());
    std::string b64(out_len, '\0');
    mbedtls_base64_encode((unsigned char*)b64.data(), b64.size(), &out_len, (const unsigned char*)jpeg.data(), jpeg.size());
    b64.resize(out_len);
    protocol->SendJson("{\"type\":\"snapshot\",\"jpeg\":\"" + b64 + "\"}");
    ESP_LOGI(TAG, "截屏传上去了（%u 字节）", (unsigned)jpeg.size());
}

void Voicelog::UpdateDisplay() {
    auto& board = Board::GetInstance();
    // 录声纹：时间到就停下等结果；等太久就算没连上
    const int64_t now = NowMs();
    if (enroll_state_ == kEnrollRecording && now - enroll_start_ms_ >= kEnrollSeconds * 1000) {
        enroll_state_ = kEnrollWaiting;
        enroll_waiting_since_ = now;
        enroll_end_pending_ = true;
        // 录音开关不动。还在名单里就先关掉麦克风，等结果；不在名单里（老路径）也先关。
        SetMic(false);
    } else if (enroll_state_ == kEnrollWaiting) {
        // 网断的时候声音还在队列里，30 秒就判失败会把后来才到的结果扔掉。
        // 网是通的、队列也空了，20 秒够服务器把声纹存上。
        const bool stuck = !online_.load() || BacklogMs() >= 3000;
        const int limit = stuck ? 180000 : 20000;
        if (now - enroll_waiting_since_ > limit) {
            std::lock_guard<std::mutex> lock(stats_mutex_);
            enroll_reason_ = stuck ? "没网，没记上" : "没连上服务器";
            if (menu_open_) menu_hint_ = enroll_reason_;
            enroll_state_ = menu_open_ ? kEnrollNone : kEnrollFail;
        }
    }
    VoicelogView view;
    view.booting = NowMs() < 2500;
    view.screen_on = screen_on_.load();
    view.upgrade_pct = upgrade_pct_.load();
    view.power_off = power_off_.load();
    view.menu = menu_open_.load();
    view.enroll_state = enroll_state_.load();
    view.enroll_left_sec = view.enroll_state == kEnrollRecording
                               ? (int)((kEnrollSeconds * 1000 - (now - enroll_start_ms_) + 999) / 1000)
                               : 0;
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        view.enroll_reason = enroll_reason_;
        if (view.menu) {
            if (people_.empty()) EnsurePeople();
            if (menu_index_ < 0 || menu_index_ >= (int)people_.size()) menu_index_ = 0;
            view.menu_index = menu_index_;
            view.menu_rows.clear();
            for (const MenuPerson& person : people_) view.menu_rows.push_back({person.label, person.enrolled});
        }
    }
    // 名单开着时不把这段算进今天的录音
    view.recording = recording_.load() && !view.menu;
    view.online = online_.load();
    view.wifi_connected = WifiManager::GetInstance().IsConnected();
    view.config_mode = Application::GetInstance().GetDeviceState() == kDeviceStateWifiConfiguring;
    // 电量走 I2C，5 秒读一次就够
    static int64_t bat_at = -10000;
    static int bat_level = -1;
    static bool bat_charging = false;
    if (NowMs() - bat_at > 5000) {
        bool discharging = false;
        board.GetBatteryLevel(bat_level, bat_charging, discharging);
        bat_at = NowMs();
    }
    view.battery = bat_level;
    view.charging = bat_charging;
    view.backlog_sec = BacklogMs() / 1000;
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        // 服务端的数 + 收到以后自己在录的时间（戴敬力 10-15：“185 一直不更新……会觉得很断层”）
        view.upgrade_to = upgrade_to_;
        view.recorded_sec = recorded_sec_;
        if (recorded_sec_ >= 0 && recording_ && !menu_open_) view.recorded_sec += (int)((NowMs() - recorded_at_ms_) / 1000);
        view.live_final = live_base_;
        view.live_partial = live_partial_;
        view.live_age_ms = live_at_ms_ < 0 ? 999999 : (uint32_t)(NowMs() - live_at_ms_);
        if (view.menu) view.menu_hint = menu_hint_;
    }
    if (view.menu) {
        char foot[48];
        if (view.enroll_state == kEnrollRecording) {
            snprintf(foot, sizeof(foot), "还剩 %d 秒    双击取消", view.enroll_left_sec);
            view.menu_foot = foot;
        } else if (view.enroll_state == kEnrollWaiting) {
            if (!view.wifi_connected || !view.online) view.menu_foot = "没网，传完再记";
            else if (view.backlog_sec >= 3) {
                snprintf(foot, sizeof(foot), "还有 %u 秒没传完", (unsigned)view.backlog_sec);
                view.menu_foot = foot;
            } else view.menu_foot = "正在记";
        } else if (!view.menu_hint.empty()) view.menu_foot = view.menu_hint;
        else view.menu_foot = "单击录音    双击退出";
    }
    if (screen_.Update(board.GetDisplay(), view) && first_frame_hook_) first_frame_hook_();
}
