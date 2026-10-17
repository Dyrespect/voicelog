// 随身录音的屏幕（CONFIG_VOICELOG_MODE）：240×240，取代小智的界面。
// 设计稿在随身录音仓库 design/：录音中一屏_定稿.html、各状态屏_初稿.html（戴敬力 10-17 定）。
//
//   ● REC                 ● LINE  93% ▮▮▮▮
//   ┌──────── 磁带（插画，转轴在转）────────┐
//   └──────────────────────────────────────┘
//   02:13                  ⌒⌒⌒ VU ⌒⌒⌒
//   二号｜那这个周五能来吗？
//
// 磁带、转轴、灯、VU 刻度、计数器滚轮都是设计稿按像素导出来的图（ui/vl_img_*.c）；
// 字体是自己转的（ui/vl_*.c）：宋体 15/13（中文）、IBM Plex Mono（英文和数字）、Caveat（标签上手写的日期）。
// 零件不加框（戴敬力 10-17：“你为什么总想着把它框起来”）；状态字最多两行，一行正常一行暗。
// 转轴、指针、峰值灯由 LVGL 定时器 30ms 一帧地动；状态由上传任务 250ms 一次推过来。
#ifndef VOICELOG_SCREEN_H
#define VOICELOG_SCREEN_H

#include <lvgl.h>

#include <functional>
#include <string>
#include <vector>

class Display;

struct VoicelogMenuRow {
    std::string label;
    bool enrolled = false;
};

struct VoicelogView {
    bool booting = false;          // 刚开机那两三秒
    bool screen_on = true;         // 屏幕亮着才让东西动（熄屏时不费电画）
    bool recording = true;
    bool online = false;           // 和服务器的通道开着
    bool wifi_connected = false;
    bool config_mode = false;      // 正在联网设置
    int upgrade_pct = -1;          // 升级下载进度（真实的：已下 / 总大小），-1 = 没在升级
    std::string upgrade_to;        // 要升到的版本
    int battery = -1;
    bool charging = false;
    uint32_t backlog_sec = 0;      // 队列里还没发出去的
    int recorded_sec = -1;         // 今天录了多久（服务端按收到的声音算，-1 = 还没收到）
    std::string live_final;        // 服务器识别出来、已经定稿的那几句（谁说的用 \x1e名字\x1f 标在句子前面）
    std::string live_partial;      // 正在说的这句（会被后面的识别结果整段替换）
    uint32_t live_age_ms = 999999; // 最后一次收到新字是多久以前
    bool power_off = false;        // 电量低、马上深睡：整屏只显示这个
    int enroll_state = 0;          // Voicelog::EnrollState：录声纹
    int enroll_left_sec = 0;
    std::string enroll_reason;
    bool menu = false;             // 声纹名单：中间是名单，不是磁带
    int menu_index = 0;
    std::vector<VoicelogMenuRow> menu_rows;
    std::string menu_hint;
    std::string menu_foot;
};

class VoicelogScreen {
public:
    /** 返回 true：这一帧是第一次把磁带画进屏幕（调用方这时再开背光） */
    bool Update(Display* display, const VoicelogView& view);
    /** 截我们这屏成 JPEG（自己在 PSRAM 开缓冲；小智自带的截屏要 LVGL 小内存池给 65KB，给不出来） */
    bool SnapshotJpeg(Display* display, std::string& jpeg, std::string& error);
    /** 麦克风音量（dBFS，没声音 / 没在录给 -100），VU 指针用 */
    void SetLevelSource(std::function<int()> source) { level_source_ = std::move(source); }

private:
    struct Wheel {
        lv_obj_t* box = nullptr;   // 滚轮底图
        lv_obj_t* cur = nullptr;   // 现在的数字
        lv_obj_t* next = nullptr;  // 滚上来的数字
        char shown = 0;
    };

    void Create();
    void SetDigits(const char* digits, bool pct);
    void SetLines(const char* main, const char* dim);
    void SetMenu(const VoicelogView& v);
    void HideMenu();
    void SetNameplate(const char* k1, const char* v1, const char* k2, const char* v2);
    void SetCaption(const VoicelogView& v);
    void Tick();
    static void TickCb(lv_timer_t* t);
    static void RollCb(void* var, int32_t v);
    static void RollDone(lv_anim_t* a);
    static void Settle(Wheel* w);

    std::function<int()> level_source_;
    lv_obj_t* screen_ = nullptr;
    bool showing_ours_ = false;
    bool presented_ = false;  // 第一帧已经整屏刷进面板
    lv_timer_t* timer_ = nullptr;

    // 顶栏
    lv_obj_t* lamp_ = nullptr;
    lv_obj_t* word_ = nullptr;
    lv_obj_t* line_dot_ = nullptr;
    lv_obj_t* line_text_ = nullptr;
    lv_obj_t* pct_ = nullptr;
    lv_obj_t* bars_[4] = {};
    // 磁带
    lv_obj_t* cas_ = nullptr;
    lv_obj_t* date_ = nullptr;
    lv_obj_t* hubs_[2] = {};
    lv_obj_t* dim_ = nullptr;
    // 计数器
    Wheel wheels_[4];
    lv_obj_t* colon_[2] = {};
    lv_obj_t* pct_sign_ = nullptr;
    // VU
    lv_obj_t* vu_ = nullptr;
    lv_obj_t* needle_[3] = {};
    lv_point_precise_t needle_pts_[3][2] = {};
    lv_obj_t* peak_ = nullptr;
    // 下面的字
    lv_obj_t* caption_ = nullptr;
    lv_obj_t* say_main_ = nullptr;
    lv_obj_t* say_dim_ = nullptr;
    // 声纹名单（磁带让开以后的六行）
    lv_obj_t* list_title_ = nullptr;
    lv_obj_t* list_mark_[6] = {};
    lv_obj_t* list_no_[6] = {};
    lv_obj_t* list_name_[6] = {};
    lv_obj_t* list_tag_[6] = {};
    lv_obj_t* kv_key_[2] = {};
    lv_obj_t* kv_val_[2] = {};
    std::string caption_fin_, caption_part_, caption_text_;  // 上次量过的字幕（字没变不重新量）
    bool caption_fading_ = false;

    // 动画状态（Update 写、定时器读，都在 LVGL 锁里）
    float hub_speed_ = 0;
    bool needle_live_ = false;
    bool widgets_ = true;
    float hub_ang_[2] = {0, 0};
    float needle_ang_ = -0.8f, needle_vel_ = 0;
    uint32_t last_tick_ = 0;
    uint32_t peak_until_ = 0;
    bool peak_on_ = false;
    bool lamp_on_ = false;
};

#endif  // VOICELOG_SCREEN_H
