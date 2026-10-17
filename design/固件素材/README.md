# 固件素材：设计稿 → 板子

屏幕代码在 `~/esp/voicelog-device/main/voicelog/voicelog_screen.cc`，用的字体和图在同目录 `ui/`。都是从这里的设计稿生成的：

1. **图**：`导出图层.py <export.html> png/`。export.html 是 `../各状态屏_初稿.html` 在最后一个 `})();` 前加一行
   `window.__vl = { lamp, wheel, vuAng, mix, C, K, Q, im, ld, L, Rt, ROW, RH, CY };`。它会导出磁带、转轴、灯、VU 刻度、滚轮，还有 `layout.json`（每样东西的位置、基线）。
2. **转成 C**：
   - 不透明的图（cas、vu、wheel）：`python3 rgb565.py png/x.png vl_img_x ui/vl_img_x.c`。和底色一样的像素按 LVGL 的截断规则转，不然图边上会露出方块。
   - 带透明的图（hub、lamp、peak、wheel_fade）：用 LVGL 自带的 `scripts/LVGLImage.py --cf ARGB8888`，再把开头的 include 换成 `#include "lvgl.h"`。
   - wheel_fade 的颜色要用 (16,16,16)，不能用底色 (13,12,11)：LVGL 叠半透明时取整会往下偏一格，用底色的话滚轮上下会多出一条暗边。
3. **字体**（`npx lv_font_conv@1.5.3 --bpp 4 --format lvgl --lv-include lvgl.h`）：
   - 宋体：Noto Serif SC 可变字体，先用 fontTools 按 `serif_chars.txt` 加空格做子集，再取 wght=500。
     - 15 号：`-r 0x20 --symbols serif_chars`，`--lv-fallback vl_mono14m`，压缩格式。板子要开 `CONFIG_LV_USE_FONT_COMPRESSED`，已写在 config.json 里。
     - 13 号：字表 `serif13_chars.txt` 是从屏幕代码的字符串里抽出来的。改了文案要重新生成，否则新字显示不出来。fallback 是 `vl_mono12m`。
   - IBM Plex Mono：Medium 12/14、SemiBold 10/14/18。
   - Caveat：wght=600，18 号，只要 `0123456789. SunMonTueWedThuFriSat`。
4. **电脑上先看**：`模拟器/` 用同一份 LVGL 和屏幕代码，把十个状态各渲成一张图，存在 out/*.ppm。
   - 用 cmake 编，lvgl 指向 `managed_components/lvgl__lvgl`。
   - 截图要用 RGB565，和板子一样。
   - 不要开 ASan，这台 Mac 上会卡在启动。
