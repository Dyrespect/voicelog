#include "voicelog_screen.h"

#include <esp_app_desc.h>
#include <esp_heap_caps.h>
#include <esp_mac.h>
#include <esp_timer.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>

#include "display.h"
#include "jpg/image_to_jpeg.h"

// 字体（ui/ 下，lv_font_conv 转的；宋体缺的英文数字会落到同号的等宽字）
LV_FONT_DECLARE(vl_serif15);   // 中文正文、字幕
LV_FONT_DECLARE(vl_serif13);   // 暗的那行
LV_FONT_DECLARE(vl_mono10b);   // 顶栏 REC / LINE / 93%
LV_FONT_DECLARE(vl_mono14b);   // 铭牌上的值、升级的 %
LV_FONT_DECLARE(vl_mono18b);   // 计数器
LV_FONT_DECLARE(vl_caveat18);  // 标签上手写的日期
// 图（设计稿按像素导出来的）
LV_IMAGE_DECLARE(vl_img_cas);
LV_IMAGE_DECLARE(vl_img_hub0);
LV_IMAGE_DECLARE(vl_img_hub1);
LV_IMAGE_DECLARE(vl_img_lamp_on);
LV_IMAGE_DECLARE(vl_img_lamp_off);
LV_IMAGE_DECLARE(vl_img_peak_on);
LV_IMAGE_DECLARE(vl_img_peak_off);
LV_IMAGE_DECLARE(vl_img_vu);
LV_IMAGE_DECLARE(vl_img_wheel);
LV_IMAGE_DECLARE(vl_img_wheel_fade);

namespace {
// 设计稿是 240×240；屏幕更大更小都按左上角对齐（StickS3 已坏，只剩正辰 1.54 寸 240×240）
int kW = 240;
int kH = 240;
constexpr int kL = 15;  // 左边线（和磁带左边对齐）
const lv_color_t kBg = lv_color_hex(0x0D0C0B);
const lv_color_t kCream = lv_color_hex(0xF2ECD6);
const lv_color_t kText = lv_color_hex(0xF1ECE0);
const lv_color_t kDim = lv_color_hex(0x8A857B);
const lv_color_t kOff = lv_color_hex(0x36322D);
const lv_color_t kRed = lv_color_hex(0xC8321F);
const lv_color_t kInk = lv_color_hex(0x2B3C6E);
constexpr const char* kDimHex = "8A857B";
constexpr const char* kKey = "BOOT";  // 板子上那颗键

// VU：轴心藏在屏幕下面，指针从暗处伸出来（和设计稿同一套数）
constexpr float kVuPx = 176, kVuPy = 266, kVuR = 94, kVuK = 0.8f, kVuBottom = 198;
constexpr int kNeedleX = 110, kNeedleY = 160;  // 指针线的原点：只重画这一小块
// 麦克风 dBFS 换成表上的刻度：-20 dBFS 的说话声落在表的 0 附近
constexpr int kVuOffset = 20;
const float kVuTable[][2] = {{-20, -0.80f}, {-10, -0.45f}, {-7, -0.28f}, {-5, -0.14f}, {-3, 0.02f}, {0, 0.32f}, {3, 0.62f}};

float VuAng(float db) {
    if (db <= kVuTable[0][0]) return kVuTable[0][1];
    for (size_t i = 1; i < sizeof(kVuTable) / sizeof(kVuTable[0]); i++) {
        if (db <= kVuTable[i][0]) {
            const float a = kVuTable[i - 1][0], aa = kVuTable[i - 1][1], b = kVuTable[i][0], bb = kVuTable[i][1];
            return aa + (bb - aa) * (db - a) / (b - a);
        }
    }
    return kVuTable[6][1];
}

lv_obj_t* Label(lv_obj_t* parent, const lv_font_t* font, lv_color_t color) {
    lv_obj_t* label = lv_label_create(parent);
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, color, 0);
    lv_label_set_text(label, "");
    return label;
}

/** 按基线放字：设计稿里写的都是基线位置 */
void AtBaseline(lv_obj_t* label, int x, int baseline) {
    const lv_font_t* f = lv_obj_get_style_text_font(label, LV_PART_MAIN);
    lv_obj_set_pos(label, x, baseline - (f->line_height - f->base_line));
}

lv_obj_t* Box(lv_obj_t* parent, int x, int y, int w, int h, lv_color_t color) {
    lv_obj_t* o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_bg_color(o, color, 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    return o;
}

lv_obj_t* Image(lv_obj_t* parent, const lv_image_dsc_t* src, int x, int y) {
    lv_obj_t* img = lv_image_create(parent);
    lv_image_set_src(img, src);
    lv_obj_set_pos(img, x, y);
    return img;
}

void SetText(lv_obj_t* label, const char* text) {
    if (strcmp(lv_label_get_text(label), text) != 0) lv_label_set_text(label, text);
}

void Show(lv_obj_t* obj, bool on) {
    if (on == lv_obj_has_flag(obj, LV_OBJ_FLAG_HIDDEN)) {
        if (on) lv_obj_remove_flag(obj, LV_OBJ_FLAG_HIDDEN);
        else lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
    }
}

void SetSrc(lv_obj_t* img, const lv_image_dsc_t* src) {
    if (lv_image_get_src(img) != src) lv_image_set_src(img, src);
}

constexpr uint32_t kFadeAfterMs = 12000;  // 多久没新字就淡出
constexpr uint32_t kFadeMs = 1500;
constexpr size_t kCaptionMaxChars = 40;
constexpr int kCaptionW = 210;
constexpr int kCaptionH = 40;  // 两行

/** 去掉 #：LVGL 的分色写法用 #RRGGBB 文字# 标记，说话内容里的 # 会搅乱它 */
std::string NoHash(std::string s) {
    s.erase(std::remove(s.begin(), s.end(), '#'), s.end());
    return s;
}

size_t CountChars(const std::string& s) {
    size_t n = 0;
    for (unsigned char c : s) n += (c & 0xC0) != 0x80;
    return n;
}

/** 只留最后 max_chars 个字（按 UTF-8 字符数），前面截掉的用“…”表示：要看到最新说的 */
std::string Tail(const std::string& s, size_t max_chars) {
    size_t count = 0;
    size_t i = s.size();
    while (i > 0) {
        --i;
        if ((static_cast<unsigned char>(s[i]) & 0xC0) != 0x80) {
            if (++count == max_chars) break;
        }
    }
    if (count < max_chars) return s;
    return "…" + s.substr(i);
}

/**
 * 字幕：定稿的亮字 + 正在识别的暗字，只留最后 n 个字。
 * 谁说的标在句子前面（\x1e名字\x1f），显示成暗的“名字｜”；截断时把半截名字去掉。
 */
std::string CaptionText(const std::string& fin, const std::string& part, size_t n) {
    std::string tail = Tail(fin + part, n);
    const size_t part_chars = std::min(CountChars(part), CountChars(tail));
    size_t cut = tail.size();
    for (size_t k = 0; k < part_chars && cut > 0;) {
        --cut;
        if ((static_cast<unsigned char>(tail[cut]) & 0xC0) != 0x80) ++k;
    }
    std::string head = tail.substr(0, cut);
    const std::string live = tail.substr(cut);
    const size_t open = head.find('\x1e'), close = head.find('\x1f');
    if (close != std::string::npos && (open == std::string::npos || close < open)) {
        head = (head.rfind("…", 0) == 0 ? std::string("…") : std::string()) + head.substr(close + 1);
    }
    std::string out;
    for (char c : head) {
        if (c == '\x1e') out += std::string("#") + kDimHex + " ";
        else if (c == '\x1f') out += "｜#";
        else out += c;
    }
    if (!live.empty()) out += std::string("#") + kDimHex + " " + live + "#";
    return out;
}

void SetOpa(void* obj, int32_t v) { lv_obj_set_style_opa(static_cast<lv_obj_t*>(obj), (lv_opa_t)v, 0); }

constexpr int kWheelX[4] = {15, 30, 52, 67};
constexpr int kPctX[3] = {15, 30, 45};
constexpr int kWheelY = 168, kDigitTop = 6, kRollStep = 21;
}  // namespace

void VoicelogScreen::Create() {
    if (auto* disp = lv_display_get_default()) {
        kW = lv_display_get_horizontal_resolution(disp);
        kH = lv_display_get_vertical_resolution(disp);
    }
    screen_ = lv_obj_create(nullptr);
    lv_obj_set_style_bg_color(screen_, kBg, 0);
    lv_obj_set_style_bg_opa(screen_, LV_OPA_COVER, 0);
    lv_obj_remove_flag(screen_, LV_OBJ_FLAG_SCROLLABLE);

    // 顶栏：灯 + 走带状态；右边 LINE（和服务器的通道）+ 电量数字 + 四格
    lamp_ = Image(screen_, &vl_img_lamp_off, 7, 0);
    word_ = Label(screen_, &vl_mono10b, kCream);
    AtBaseline(word_, 27, 15);
    line_dot_ = Box(screen_, 131, 10, 4, 4, kCream);
    lv_obj_set_style_radius(line_dot_, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_color(line_dot_, kDim, 0);
    line_text_ = Label(screen_, &vl_mono10b, kDim);
    lv_label_set_text(line_text_, "LINE");
    AtBaseline(line_text_, 139, 15);
    pct_ = Label(screen_, &vl_mono10b, kCream);
    lv_obj_set_width(pct_, 40);
    lv_obj_set_style_text_align(pct_, LV_TEXT_ALIGN_RIGHT, 0);
    AtBaseline(pct_, 158, 15);
    for (int i = 0; i < 4; i++) bars_[i] = Box(screen_, 203 + i * 6, 8, 4, 9, kOff);

    // 磁带：插画 + 今天的日期（手写体）+ 两个转轴
    cas_ = Image(screen_, &vl_img_cas, 15, 27);
    date_ = Label(screen_, &vl_caveat18, kInk);
    AtBaseline(date_, 51, 62);
    const lv_image_dsc_t* hub_src[2] = {&vl_img_hub0, &vl_img_hub1};
    const int hub_x[2] = {64, 152};
    for (int i = 0; i < 2; i++) {
        hubs_[i] = Image(screen_, hub_src[i], hub_x[i], 76);
        lv_image_set_pivot(hubs_[i], 12, 12);
    }
    dim_ = Box(screen_, 14, 26, 212, 135, kBg);
    lv_obj_set_style_bg_opa(dim_, 158, 0);  // 电量低时磁带暗下去
    Show(dim_, false);

    // 计数器：四个滚轮直接在黑底上，不加框
    for (int i = 0; i < 4; i++) {
        Wheel& w = wheels_[i];
        w.box = Image(screen_, &vl_img_wheel, kWheelX[i], kWheelY);
        for (lv_obj_t** d : {&w.cur, &w.next}) {
            *d = Label(w.box, &vl_mono18b, kCream);
            lv_obj_set_width(*d, 13);
            lv_obj_set_style_text_align(*d, LV_TEXT_ALIGN_CENTER, 0);
            lv_obj_set_pos(*d, 0, kDigitTop);
        }
        Show(w.next, false);
        Image(w.box, &vl_img_wheel_fade, 0, 0);
    }
    colon_[0] = Box(screen_, 47, 177, 2, 2, kCream);
    colon_[1] = Box(screen_, 47, 185, 2, 2, kCream);
    for (auto* c : colon_) lv_obj_set_style_radius(c, LV_RADIUS_CIRCLE, 0);
    pct_sign_ = Label(screen_, &vl_mono14b, kDim);
    lv_label_set_text(pct_sign_, "%");
    AtBaseline(pct_sign_, 62, 186);
    Show(pct_sign_, false);

    // VU：刻度是图，指针三段（越往下越淡，像从暗处伸出来），峰值灯
    vu_ = Image(screen_, &vl_img_vu, 116, 164);
    const lv_opa_t seg_opa[3] = {LV_OPA_COVER, 170, 70};
    for (int i = 0; i < 3; i++) {
        needle_[i] = lv_line_create(screen_);
        lv_obj_set_pos(needle_[i], kNeedleX, kNeedleY);
        lv_obj_set_style_line_width(needle_[i], 1, 0);
        lv_obj_set_style_line_color(needle_[i], kCream, 0);
        lv_obj_set_style_line_opa(needle_[i], seg_opa[i], 0);
    }
    peak_ = Image(screen_, &vl_img_peak_off, 209, 180);

    // 下面的字：字幕两行；状态一行正常一行暗；联网设置是两行铭牌
    caption_ = Label(screen_, &vl_serif15, kText);
    lv_label_set_recolor(caption_, true);
    lv_obj_set_width(caption_, kCaptionW);
    lv_obj_set_height(caption_, kCaptionH);
    lv_label_set_long_mode(caption_, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_line_space(caption_, -1, 0);  // 行距 19，和设计稿一样
    AtBaseline(caption_, kL, 216);
    say_main_ = Label(screen_, &vl_serif15, kText);
    say_dim_ = Label(screen_, &vl_serif13, kDim);
    for (lv_obj_t* line : {say_main_, say_dim_}) {
        lv_obj_set_width(line, kCaptionW);
        lv_label_set_long_mode(line, LV_LABEL_LONG_DOT);
    }
    // 声纹名单：磁带让开，中间最多六行。选中的左边一条短线，录过的右边写「已录」。
    list_title_ = Label(screen_, &vl_serif13, kDim);
    SetText(list_title_, "声纹");
    AtBaseline(list_title_, kL, 40);
    Show(list_title_, false);
    for (int i = 0; i < 6; i++) {
        list_mark_[i] = Box(screen_, 15, 0, 2, 14, kCream);
        list_no_[i] = Label(screen_, &vl_mono14b, kDim);
        lv_obj_set_width(list_no_[i], 26);
        list_name_[i] = Label(screen_, &vl_serif15, kText);
        lv_obj_set_width(list_name_[i], 118);
        lv_label_set_long_mode(list_name_[i], LV_LABEL_LONG_DOT);
        list_tag_[i] = Label(screen_, &vl_serif13, kDim);
        lv_obj_set_width(list_tag_[i], 52);
        lv_obj_set_style_text_align(list_tag_[i], LV_TEXT_ALIGN_RIGHT, 0);
        Show(list_mark_[i], false);
        Show(list_no_[i], false);
        Show(list_name_[i], false);
        Show(list_tag_[i], false);
    }
    for (int i = 0; i < 2; i++) {
        kv_key_[i] = Label(screen_, &vl_serif13, kDim);
        kv_val_[i] = Label(screen_, &vl_mono14b, kText);
    }

    timer_ = lv_timer_create(TickCb, 30, this);
}

void VoicelogScreen::TickCb(lv_timer_t* t) { static_cast<VoicelogScreen*>(lv_timer_get_user_data(t))->Tick(); }

void VoicelogScreen::RollCb(void* var, int32_t v) {
    auto* w = static_cast<Wheel*>(var);
    lv_obj_set_y(w->cur, kDigitTop - v);
    lv_obj_set_y(w->next, kDigitTop + kRollStep - v);
}

void VoicelogScreen::RollDone(lv_anim_t* a) { Settle(static_cast<Wheel*>(a->var)); }

/** 滚完（或被打断）：新数字落到正中，滚上来的那个藏起来 */
void VoicelogScreen::Settle(Wheel* w) {
    char s[2] = {w->shown, 0};
    lv_label_set_text(w->cur, s);
    lv_obj_set_style_text_color(w->cur, w->shown == '-' ? kDim : kCream, 0);
    lv_obj_set_y(w->cur, kDigitTop);
    lv_obj_add_flag(w->next, LV_OBJ_FLAG_HIDDEN);
}

/** 计数器：变了的轮子往上滚一格（600ms），像机械计数器 */
void VoicelogScreen::SetDigits(const char* digits, bool pct) {
    const int n = pct ? 3 : 4;
    for (int i = 0; i < 4; i++) {
        Wheel& w = wheels_[i];
        Show(w.box, i < n);
        if (i >= n) continue;
        lv_obj_set_x(w.box, pct ? kPctX[i] : kWheelX[i]);
        const char c = digits[i];
        if (c == w.shown) continue;
        const char was = w.shown;
        if (lv_anim_delete(&w, RollCb)) Settle(&w);  // 上一格还没滚完：先落定
        w.shown = c;
        if (was == 0 || c == '-' || was == '-') {
            Settle(&w);  // 不滚：直接换
            continue;
        }
        char s[2] = {c, 0};
        lv_label_set_text(w.next, s);
        lv_obj_set_style_text_color(w.next, kCream, 0);
        lv_obj_set_y(w.next, kDigitTop + kRollStep);
        lv_obj_remove_flag(w.next, LV_OBJ_FLAG_HIDDEN);
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, &w);
        lv_anim_set_exec_cb(&a, RollCb);
        lv_anim_set_values(&a, 0, kRollStep);
        lv_anim_set_duration(&a, 600);
        lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
        lv_anim_set_completed_cb(&a, RollDone);
        lv_anim_start(&a);
    }
    for (auto* c : colon_) Show(c, !pct);
    Show(pct_sign_, pct);
}

/** 状态字：一行正常、一行暗；没有零件的屏从 200 开始写，有零件的从 216 */
void VoicelogScreen::SetLines(const char* main, const char* dim) {
    const int y0 = widgets_ ? 216 : 200;
    SetText(say_main_, main);
    SetText(say_dim_, dim);
    AtBaseline(say_main_, kL, y0);
    AtBaseline(say_dim_, kL, y0 + 21);
    Show(say_main_, main[0] != 0);
    Show(say_dim_, dim[0] != 0);
    Show(caption_, false);
    for (int i = 0; i < 2; i++) {
        Show(kv_key_[i], false);
        Show(kv_val_[i], false);
    }
}

void VoicelogScreen::HideMenu() {
    Show(list_title_, false);
    for (int i = 0; i < 6; i++) {
        Show(list_mark_[i], false);
        Show(list_no_[i], false);
        Show(list_name_[i], false);
        Show(list_tag_[i], false);
    }
    Show(cas_, true);
    Show(date_, true);
    for (auto* hub : hubs_) Show(hub, true);
}

/** 声纹页：顶栏不动，中间是名单，最下面一行按键。一行放得下，不再把字画出屏幕。 */
void VoicelogScreen::SetMenu(const VoicelogView& v) {
    Show(cas_, false);
    Show(date_, false);
    for (auto* hub : hubs_) Show(hub, false);
    Show(dim_, false);
    Show(list_title_, true);
    Show(caption_, false);
    Show(say_main_, false);
    for (int i = 0; i < 2; i++) {
        Show(kv_key_[i], false);
        Show(kv_val_[i], false);
    }
    const int n = (int)v.menu_rows.size();
    const int window = std::min(n, 6);
    int start = 0;
    if (n > 6) {
        start = v.menu_index - 2;
        if (start < 0) start = 0;
        if (start > n - 6) start = n - 6;
    }
    for (int i = 0; i < 6; i++) {
        if (i >= window) {
            Show(list_mark_[i], false);
            Show(list_no_[i], false);
            Show(list_name_[i], false);
            Show(list_tag_[i], false);
            continue;
        }
        const int index = start + i;
        const VoicelogMenuRow& row = v.menu_rows[index];
        const bool on = index == v.menu_index;
        const int baseline = 68 + i * 26;
        Show(list_mark_[i], on);
        lv_obj_set_pos(list_mark_[i], 15, baseline - 14);
        char no[16];
        snprintf(no, sizeof(no), "%02u", (unsigned)(index + 1));
        SetText(list_no_[i], no);
        lv_obj_set_style_text_color(list_no_[i], on ? kCream : kDim, 0);
        AtBaseline(list_no_[i], 22, baseline);
        Show(list_no_[i], true);
        SetText(list_name_[i], row.label.c_str());
        lv_obj_set_style_text_color(list_name_[i], on ? kText : kDim, 0);
        AtBaseline(list_name_[i], 52, baseline);
        Show(list_name_[i], true);
        const char* tag = "";
        char sec[16];
        if (on && v.enroll_state == 1) {
            snprintf(sec, sizeof(sec), "%u", (unsigned)std::clamp(v.enroll_left_sec, 0, 99));
            tag = sec;
        } else if (on && v.enroll_state == 2) tag = "在记";
        else if (row.enrolled) tag = "已录";
        SetText(list_tag_[i], tag);
        AtBaseline(list_tag_[i], 176, baseline);
        Show(list_tag_[i], tag[0] != 0);
    }
    SetText(say_dim_, v.menu_foot.c_str());
    AtBaseline(say_dim_, kL, 226);
    Show(say_dim_, !v.menu_foot.empty());
}

/** 联网设置：两行铭牌（标签暗、值亮） */
void VoicelogScreen::SetNameplate(const char* k1, const char* v1, const char* k2, const char* v2) {
    const char* keys[2] = {k1, k2};
    const char* vals[2] = {v1, v2};
    for (int i = 0; i < 2; i++) {
        SetText(kv_key_[i], keys[i]);
        SetText(kv_val_[i], vals[i]);
        AtBaseline(kv_key_[i], kL, 200 + i * 21);
        AtBaseline(kv_val_[i], kL + 34, 200 + i * 21);
        Show(kv_key_[i], true);
        Show(kv_val_[i], true);
    }
    Show(say_main_, false);
    Show(say_dim_, false);
    Show(caption_, false);
}

void VoicelogScreen::SetCaption(const VoicelogView& v) {
    Show(say_main_, false);
    Show(say_dim_, false);
    for (int i = 0; i < 2; i++) {
        Show(kv_key_[i], false);
        Show(kv_val_[i], false);
    }
    Show(caption_, true);
    // 戴敬力 10-15：出现就直接显示，消失要渐隐；没说完的那句会被纠正替换。12 秒没新字就 1.5 秒淡出
    const std::string fin = NoHash(v.live_final);
    const std::string part = NoHash(v.live_partial);
    if (fin.empty() && part.empty()) {
        SetText(caption_, "");
    } else if (v.live_age_ms < kFadeAfterMs) {
        // 从最后 40 个字往少了试，挑放得进两行的最多那个：按字体实际量。字没变就不重新量
        if (fin != caption_fin_ || part != caption_part_) {
            caption_fin_ = fin;
            caption_part_ = part;
            const lv_font_t* font = lv_obj_get_style_text_font(caption_, LV_PART_MAIN);
            for (size_t n = kCaptionMaxChars; n > 0; --n) {
                caption_text_ = CaptionText(fin, part, n);
                lv_point_t size;
                lv_text_get_size(&size, caption_text_.c_str(), font, 0, -1, kCaptionW, LV_TEXT_FLAG_RECOLOR);
                if (size.y <= kCaptionH) break;
            }
        }
        SetText(caption_, caption_text_.c_str());
        if (caption_fading_) {
            lv_anim_delete(caption_, SetOpa);
            caption_fading_ = false;
        }
        lv_obj_set_style_opa(caption_, LV_OPA_COVER, 0);
    } else if (!caption_fading_) {
        caption_fading_ = true;
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, caption_);
        lv_anim_set_exec_cb(&a, SetOpa);
        lv_anim_set_values(&a, LV_OPA_COVER, LV_OPA_TRANSP);
        lv_anim_set_duration(&a, kFadeMs);
        lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
        lv_anim_start(&a);
    }
}

void VoicelogScreen::Tick() {
    const uint32_t now = lv_tick_get();
    uint32_t dt = last_tick_ ? now - last_tick_ : 30;
    last_tick_ = now;
    if (dt > 100) dt = 100;
    // 转轴：两边转速不一样（左边带子多、转得慢）
    if (hub_speed_ > 0) {
        const float k[2] = {0.62f, 1.15f};
        for (int i = 0; i < 2; i++) {
            hub_ang_[i] = fmodf(hub_ang_[i] + dt * 0.0042f * k[i] * hub_speed_, 2 * (float)M_PI);
            lv_image_set_rotation(hubs_[i], (int32_t)(hub_ang_[i] * 1800 / (float)M_PI));
        }
    }
    if (!widgets_) return;
    // 指针：弹簧阻尼，跟设计稿同一套参数
    float db = -21;
    if (needle_live_ && level_source_) db = std::clamp((float)(level_source_() + kVuOffset), -21.0f, 3.3f);
    const float target = VuAng(db);
    needle_vel_ += (target - needle_ang_) * 0.012f * dt;
    needle_vel_ *= powf(0.86f, dt / 16.0f);
    float ang = std::clamp(needle_ang_ + needle_vel_ * dt / 16.0f, VuAng(-21), VuAng(3.3f));
    if (fabsf(ang - needle_ang_) > 0.0004f || needle_pts_[0][0].x == 0) {
        needle_ang_ = ang;
        const float a = -(float)M_PI / 2 + needle_ang_ * kVuK;
        const float tx = kVuPx + cosf(a) * (kVuR + 4), ty = kVuPy + sinf(a) * (kVuR + 4);
        const float t = (kVuPy - kVuBottom) / (kVuPy - ty);
        const float bx = kVuPx + (tx - kVuPx) * t;
        const float f[4] = {0, 0.55f, 0.8f, 1};
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 2; j++) {
                const float u = f[i + j];
                needle_pts_[i][j].x = (lv_value_precise_t)lroundf(tx + (bx - tx) * u) - kNeedleX;
                needle_pts_[i][j].y = (lv_value_precise_t)lroundf(ty + (kVuBottom - ty) * u) - kNeedleY;
            }
            lv_line_set_points(needle_[i], needle_pts_[i], 2);
        }
    }
    // 峰值灯：过 0 就亮，至少亮 150ms
    if (needle_live_ && db > 0.5f) peak_until_ = now + 150;
    const bool peak = (int32_t)(peak_until_ - now) > 0;
    if (peak != peak_on_) {
        peak_on_ = peak;
        SetSrc(peak_, peak ? &vl_img_peak_on : &vl_img_peak_off);
    }
}

bool VoicelogScreen::Update(Display* display, const VoicelogView& v) {
    if (display == nullptr) return false;
    DisplayLockGuard lock(display);
    if (screen_ == nullptr) Create();
    if (!showing_ours_) {
        lv_screen_load(screen_);
        showing_ours_ = true;
    }
    // 熄屏时什么都不画（戴敬力 10-17 要省电：背光关了以后还在一秒刷四次屏）；亮屏后下一次（≤250ms）整屏跟上
    if (!v.screen_on) {
        lv_timer_pause(timer_);
        return false;
    }
    lv_timer_resume(timer_);

    char buf[64], buf2[64];
    const uint32_t ms = lv_tick_get();

    // 今天的日期和星期（北京时间；还没对上时就不写，不显示假日期）
    time_t now = time(nullptr);
    if (now > 1700000000) {
        now += 8 * 3600;
        struct tm tm;
        gmtime_r(&now, &tm);
        static const char* kWd[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
        snprintf(buf, sizeof(buf), "%02d.%02d  %s", tm.tm_mon + 1, tm.tm_mday, kWd[tm.tm_wday]);
        SetText(date_, buf);
    }

    // 现在是哪一屏（先后顺序就是优先级）
    enum Mode { kBoot, kSleep, kSetup, kUpgrade, kEnroll, kMenu, kStopped, kRec } mode;
    if (v.power_off) mode = kSleep;
    else if (v.config_mode) mode = kSetup;
    else if (v.upgrade_pct >= 0) mode = kUpgrade;
    else if (v.booting) mode = kBoot;
    else if (v.menu) mode = kMenu;
    else if (v.enroll_state != 0) mode = kEnroll;
    else if (!v.recording) mode = kStopped;
    else mode = kRec;
    const bool rec_on = (mode == kRec) || (v.enroll_state == 1 && (mode == kEnroll || mode == kMenu));

    // 顶栏
    const char* word = "";
    switch (mode) {
        case kBoot: word = ""; break;
        case kSleep: word = "SLEEP"; break;
        case kSetup: word = "SETUP"; break;
        case kUpgrade: word = "UPDATE"; break;
        default: word = rec_on ? "REC" : "STOP"; break;
    }
    SetText(word_, word);
    lv_obj_set_style_text_color(word_, rec_on ? kCream : kDim, 0);
    Show(lamp_, mode != kBoot);
    if (rec_on != lamp_on_) {
        lamp_on_ = rec_on;
        SetSrc(lamp_, rec_on ? &vl_img_lamp_on : &vl_img_lamp_off);
    }
    // LINE：亮 = 连着服务器；闪 = 正在连 / 正在补传；空心 = 没网
    const bool show_line = mode != kBoot && mode != kSleep;
    Show(line_dot_, show_line);
    Show(line_text_, show_line);
    if (show_line) {
        bool filled = v.online;
        if (v.wifi_connected && (!v.online || v.backlog_sec >= 3)) filled = (ms / 500) % 2 == 0;
        if (!v.wifi_connected || mode == kSetup) filled = false;
        lv_obj_set_style_bg_opa(line_dot_, filled ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(line_dot_, filled ? 0 : 1, 0);
    }
    // 电量：数字 + 四格；充电时格子一格格往上走；15% 及以下不充电时变红
    const bool has_bat = v.battery >= 0;
    Show(pct_, has_bat);
    for (auto* b : bars_) Show(b, has_bat);
    if (has_bat) {
        const bool low = v.battery <= 15 && !v.charging;
        snprintf(buf, sizeof(buf), "%d%%", v.battery);
        SetText(pct_, buf);
        lv_obj_set_style_text_color(pct_, low ? kRed : kCream, 0);
        const int lv = std::max(1, (v.battery + 24) / 25);
        int lit = lv;
        if (v.charging && lv < 4) lit = std::min(4, lv + (int)((ms / 600) % (5 - lv)));
        for (int i = 0; i < 4; i++) lv_obj_set_style_bg_color(bars_[i], i < lit ? (low ? kRed : kCream) : kOff, 0);
    }

    // 磁带：录着就转，升级时快进，开机慢慢转起来，其他时候停
    hub_speed_ = mode == kRec || (mode == kEnroll && v.enroll_state == 1) ? 1.0f
                 : mode == kUpgrade                                          ? 6.0f
                 : mode == kBoot                                             ? 0.25f
                                                                             : 0.0f;
    Show(dim_, mode == kSleep);

    // 零件：开机、联网设置、电量低这三屏没有
    widgets_ = !(mode == kBoot || mode == kSetup || mode == kSleep || mode == kMenu);
    for (auto& w : wheels_) Show(w.box, widgets_);
    for (auto* c : colon_) Show(c, widgets_);
    Show(pct_sign_, false);
    Show(vu_, widgets_);
    for (auto* n : needle_) Show(n, widgets_);
    Show(peak_, widgets_);
    needle_live_ = widgets_ && rec_on;
    if (widgets_) {
        if (mode == kUpgrade) {
            snprintf(buf, sizeof(buf), "%03d", std::clamp(v.upgrade_pct, 0, 100));
            SetDigits(buf, true);
        } else if (mode == kEnroll) {
            const int left = v.enroll_state == 1 ? std::clamp(v.enroll_left_sec, 0, 99) : 0;
            snprintf(buf, sizeof(buf), "00%02d", left);
            SetDigits(buf, false);
        } else if (v.recorded_sec < 0) {
            SetDigits("----", false);
        } else {
            const int h = std::min(99, v.recorded_sec / 3600), m = (v.recorded_sec % 3600) / 60;
            snprintf(buf, sizeof(buf), "%02d%02d", h, m);
            SetDigits(buf, false);
        }
    }

    // 下面的字。声纹页不走这两行，中间整块是名单。
    if (mode != kMenu) HideMenu();
    const unsigned mm = v.backlog_sec / 60, ss = v.backlog_sec % 60;
    switch (mode) {
        case kBoot:
            snprintf(buf, sizeof(buf), "v%s", esp_app_get_description()->version);
            SetLines("随身录", buf);
            break;
        case kSleep:
            snprintf(buf, sizeof(buf), "插电或按 %s 醒来，接着录", kKey);
            SetLines("电量低，先睡了", buf);
            break;
        case kSetup: {
            uint8_t mac[6] = {};
            esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);  // 和小智开热点用的同一个 MAC
            snprintf(buf, sizeof(buf), "Voicelog-%02X%02X", mac[4], mac[5]);
            SetNameplate("热点", buf, "网址", "192.168.4.1");
            break;
        }
        case kUpgrade:
            snprintf(buf, sizeof(buf), "%s → %s", esp_app_get_description()->version, v.upgrade_to.c_str());
            SetLines("升级中，别关机", v.upgrade_to.empty() ? "" : buf);
            break;
        case kEnroll:
            switch (v.enroll_state) {
                case 1: SetLines("录声纹，正常说话", "到时间自动结束"); break;
                case 2: SetLines("正在记…", v.menu ? "双击 BOOT 退出" : ""); break;
                case 3:
                    snprintf(buf, sizeof(buf), "单击 %s 开始录音", kKey);
                    SetLines("录好了", buf);
                    break;
                default:
                    snprintf(buf, sizeof(buf), "双击 %s 再录，单击开始录音", kKey);
                    SetLines(v.enroll_reason.empty() ? "没听清" : v.enroll_reason.c_str(), buf);
                    break;
            }
            break;
        case kMenu:
            SetMenu(v);
            break;
        case kStopped:
            snprintf(buf, sizeof(buf), "单击 %s 接着录", kKey);
            SetLines("已停止", buf);
            break;
        case kRec:
            if (!v.wifi_connected) {
                snprintf(buf, sizeof(buf), "已存 %u:%02u", mm, ss);
                SetLines("没网，先存在机器里", buf);
            } else if (!v.online) {
                if (v.backlog_sec >= 3) snprintf(buf2, sizeof(buf2), "先存着 %u:%02u", mm, ss);
                else buf2[0] = 0;
                SetLines("连接中", buf2);
            } else if (v.backlog_sec >= 3) {
                snprintf(buf, sizeof(buf), "还剩 %u 秒", (unsigned)v.backlog_sec);
                SetLines("补传中", buf);
            } else {
                SetCaption(v);
            }
            break;
    }
    // 第一帧整屏刷进面板再告诉外面开背光。不刷完就开，小智那张白屏会露一帧。
    if (presented_) return false;
    presented_ = true;
    lv_obj_invalidate(screen_);
    lv_refr_now(nullptr);
    return true;
}

bool VoicelogScreen::SnapshotJpeg(Display* display, std::string& jpeg, std::string& error) {
    if (display == nullptr || screen_ == nullptr) {
        error = "screen not ready";
        return false;
    }
    const uint32_t stride = lv_draw_buf_width_to_stride(kW, LV_COLOR_FORMAT_RGB565);
    const uint32_t size = stride * kH;
    void* mem = heap_caps_malloc(size, MALLOC_CAP_SPIRAM);
    if (mem == nullptr) {
        error = "no psram";
        return false;
    }
    bool ok = false;
    {
        DisplayLockGuard lock(display);
        lv_draw_buf_t buf;
        lv_draw_buf_init(&buf, kW, kH, LV_COLOR_FORMAT_RGB565, stride, mem, size);
        if (lv_snapshot_take_to_draw_buf(screen_, LV_COLOR_FORMAT_RGB565, &buf) != LV_RESULT_OK) {
            error = "lv_snapshot_take_to_draw_buf failed";
        } else {
            ok = true;
        }
    }
    if (ok) {
        // JPEG 编码要宽度是 16 的倍数（135 不行，2.6.9 实测 “jpeg encode failed”）：右边补黑
        const uint32_t kJw = ((uint32_t)kW + 15) & ~15u;
        auto* padded = static_cast<uint16_t*>(heap_caps_calloc(kJw * kH, 2, MALLOC_CAP_SPIRAM));
        if (padded == nullptr) {
            heap_caps_free(mem);
            error = "no psram for padding";
            return false;
        }
        const auto* src = static_cast<const uint8_t*>(mem);
        for (uint32_t y = 0; y < (uint32_t)kH; y++) {
            const auto* row = reinterpret_cast<const uint16_t*>(src + y * stride);
            // 不对调字节：JPEG 编码器要的就是 LVGL 原样的 RGB565（以前对调过，黑白界面看不出来，10-17 彩色界面截出来全是紫的）
            for (uint32_t x = 0; x < (uint32_t)kW; x++) padded[y * kJw + x] = row[x];
        }
        jpeg.clear();
        ok = image_to_jpeg_cb(reinterpret_cast<uint8_t*>(padded), kJw * kH * 2, kJw, kH, V4L2_PIX_FMT_RGB565, 75,
                              [](void* arg, size_t, const void* data, size_t len) -> size_t {
                                  if (data && len > 0) static_cast<std::string*>(arg)->append(static_cast<const char*>(data), len);
                                  return len;
                              },
                              &jpeg);
        heap_caps_free(padded);
        if (!ok) error = "jpeg encode failed";
    }
    heap_caps_free(mem);
    return ok;
}
