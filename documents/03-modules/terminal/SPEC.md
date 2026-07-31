# 交互式终端模块（terminal / TERM）

> 状态：接近规格 ｜ 依赖：_foundation、ansi
> 对应 V2 §1.2 模式A。GUI 渲染 + 键盘交互，消费 ansi 模块的 ScreenBuffer。

## 1. 定位
交互式终端 Viewport：完整 ANSI 渲染（消费 ansi ScreenBuffer）+ 击键直传 + 控制字符 + 本地回显 + 粘贴 + 回滚查看。

## 2. 组件

### 2.1 终端 Viewport（terminal_viewport，GUI）
- 用 DPG `draw_text` 逐行渲染 ScreenBuffer（T0-T08 spike 验证的性能方案）。
- 只渲染 dirty_rows + 可见区（虚拟化）。
- CJK 宽字符对齐（ANS-T07）。

### 2.2 键盘处理（emulator / keyboard）
- **击键直传**：按键直接发送到串口（不回显由远端控制）。
- **本地回显**：远端不回显时可开启本地同步显示输入（行编辑 + 退格/回车）。
- 控制字符：Ctrl+C/D/Z（0x03/0x04/0x1A）、方向键（转义序列）、Tab。
- **文本选择 → 复制**（不发送）。
- **粘贴**：逐行发送 + 可配置延迟（ADR-0009）。

### 2.3 回滚 + 选择
- 回滚缓冲（ansi ScrollbackBuffer）上滚查看。
- 选中文本 → 剪贴板（不发送，避免误操作）。

## 3. 关键不变量
- **INV-1**：击键默认直传，不回显由远端控制；本地回显是显式开关。
- **INV-2**：文本选择只复制不发送。
- **INV-3**：回滚查看不修改 ScreenBuffer 当前状态。
- **INV-4**：发送数据走统一发送路径（交互击键 vs 传统发送框，见 ADR-0015）。

## 4. 任务卡
| 卡 | 标题 | blocked-by |
|---|---|---|
| TERM-T01 | 终端 Viewport 渲染（draw_text 逐行 + dirty_rows + CJK） | ANS-T07, T0-T08 |
| TERM-T02 | 击键直传 + 控制字符 + 方向键/Tab | TERM-T01 |
| TERM-T03 | 本地回显（行编辑 + 退格/回车，开关） | TERM-T02 |
| TERM-T04 | 文本选择 → 复制（不发送） | TERM-T01 |
| TERM-T05 | 粘贴（逐行 + 可配置延迟，ADR-0009） | TERM-T02 |
| TERM-T06 | 回滚上滚查看（只读） | ANS-T08, TERM-T01 |
| TERM-T07 | 光标闪烁 + 终端状态栏（端口/波特率） | TERM-T01 |
| TERM-T08 | 终端回滚搜索（O6，待确认，倾向补） | TERM-T06 |
