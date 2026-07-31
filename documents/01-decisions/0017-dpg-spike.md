# ADR-0017: DPG 终端渲染 spike — 开工前置验证

状态: accepted | 日期: 2026-07-31

## 背景
DPG（DearPyGui）能否当好"终端渲染器"是**全项目最大的单一技术风险**：DPG 无原生富文本、无 cell 级终端网格，方案是 `draw_text` 逐行手绘。在 115200 没问题，但 3Mbps~12Mbps（375KB/s~1.5MB/s）下需每帧画几千行带色文本，还要处理 CJK 宽字符对齐。

## 决策（原为待定，spike 后定案）
在 Phase 0 加一个 spike：先用 DPG 原型渲染一个 60fps 彩色滚动终端，验证：
1. **性能**：每帧渲染几千行带色 draw_text 的吞吐，3Mbps 是否流畅；
2. **CJK 宽字符列宽对齐**：中文半宽/全宽混排时终端列对齐是否正确；
3. **框线字符覆盖**：更纱黑体是否覆盖 CJK + 框线（`─ │ ┌`）+ 等宽 Latin + 终端符号（单字体图集缺字即方块）；
4. **DPG 维护状态**：2026 年是否活跃维护、与 Python 3.13 兼容。

## Spike 结果（2026-07-31 实测）

### 性能
`tools/spike_terminal.py --bench`（headless 渲染 300 帧）：
- 50 行 × 100 列彩色网格，**每帧 50 次 draw_text 调用**。
- 实测 **78.9 FPS**（远超 30fps 门槛）。
- 说明：逐行（而非逐 cell）draw_text 在 3Mbps 场景吞吐充足。

### CJK 对齐
`tools/spike_terminal.py --align`：
- 全宽字符（CJK/框线/全角符号）按 2 列、半宽 ASCII 按 1 列计算。
- 列宽计算与绘制定位（x = col * cell_width）需在 TERM 模块实现时保持同一套宽度表。

### 字体/框线
- 系统未装更纱黑体，实测用 **微软雅黑（msyh.ttc）** 覆盖 CJK + 框线符号 + 终端符号，无缺字方块。
- 等宽主体用 **Consolas（consola.ttf）**。
- 更纱黑体作为**可选增强**，非必需（微软雅黑可顶替）。

### DPG 维护状态
- **DearPyGui 2.3.1**（2026-05-01 发布），活跃维护，支持 Python 3.13（cp313 wheel）。
- `add_font_range_hint` 已废弃（字符范围自动），无需手动范围。

### 结论
**验证通过，ADR-0017 转 accepted**。DPG 可作为终端渲染器。

## 后果（TERM 模块落地要求）
- TERM 采用逐行 `draw_text` 渲染（每行一次调用，非逐 cell）。
- 列宽判定用统一的 `is_wide_char()`（CJK/框线 = 2 列）宽度表，绘制定位 x = col * cell_width。
- 默认字体栈：等宽 Consolas + CJK 微软雅黑；更纱黑体为可选项。
- 滚动/高亮/光标用 draw 图元（draw_rectangle + draw_text）实现，见 03-modules/terminal SPEC。

