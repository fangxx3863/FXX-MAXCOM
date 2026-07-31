# ANSI 解析引擎模块（ansi / ANS）

> 状态：接近规格 ｜ 依赖：_foundation（T0）
> 对应 V2 §1.3 + §4.1。纯 Python 状态机，无 GUI 依赖。核心子集（ADR-0001）。

## 1. 定位
解析 ANSI 转义序列，维护虚拟屏幕缓冲区（带样式属性的二维字符网格）。只做**核心子集**：SGR + 光标移动 + 滚动区域 + 清屏。不支持的序列 → 记录日志 + 静默跳过，绝不崩溃。

## 2. 组件

### 2.1 ANSI 解析器（parser）
状态机解析原始字节流 → 动作（写字符 / 光标移动 / SGR / 擦除 / 滚动 / 清屏）。

状态：GROUND / ESCAPE / CSI_ENTRY / CSI_PARAM / CSI_IGM / OSC_STR（见 V2 §4.1 状态机图）。

### 2.2 屏幕缓冲区（screen_buffer）
- 每行 `list[Cell]`，`Cell = (char, SgrState)`。
- 回滚缓冲区为环形队列，存被滚出的行。
- 行级脏标记 `get_dirty_rows()`，只重绘 changed_lines。

### 2.3 SGR 状态（sgr）
16色 / 256色 / 真彩色 / 粗体 / 斜体 / 下划线 / 删除线 / 反色。可序列化为 DPG 可用的前景/背景色。

## 3. 关键不变量
- **INV-1**：未知序列静默跳过，解析器状态不崩溃、不挂起（总有状态回归 GROUND 的路径）。
- **INV-2**：CJK 宽字符占 2 列，光标移动按列宽。
- **INV-3**：滚动区域外不得滚动（`set_scroll_region` 语义）。
- **INV-4**：解析器是纯函数式的：输入 bytes → 更新 buffer，无副作用、无 GUI 依赖，可单测。

## 4. 数据契约
- 输入：`bytes`（原始流片段）。
- 输出：更新后的 `ScreenBuffer` + `dirty_rows`。
- 消费方：TERM 模块（交互式终端 Viewport）。

## 5. 任务卡
| 卡 | 标题 | blocked-by |
|---|---|---|
| ANS-T01 | SGR 解析与状态（16/256/真彩 + 粗体/斜体/下划线/删除线/反色） | T0 |
| ANS-T02 | 光标移动（CUU/CUD/CUF/CUB/CHA/CUP/HVP/SCP/RCP/隐藏光标） | ANS-T01 |
| ANS-T03 | 擦除与清屏（ED/EL） | ANS-T01 |
| ANS-T04 | 滚动区域 + 上滚/下滚（"原地刷新"） | ANS-T01 |
| ANS-T05 | 插入/删除行列（IL/DL/DCH/ECH，P1） | ANS-T01 |
| ANS-T06 | DEC 兼容（DECSC/DECRC/RI/IND/NEL/RIS） | ANS-T01 |
| ANS-T07 | 屏幕缓冲区 + 脏标记 + CJK 宽字符 | ANS-T01 |
| ANS-T08 | 回滚缓冲区（环形队列） | ANS-T07 |
| ANS-T09 | 未知序列容错（记录 + 跳过，INV-1） | ANS-T01 |
