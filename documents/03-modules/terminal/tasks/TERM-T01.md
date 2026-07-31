# TERM-T01: 终端 Viewport 渲染

> 模块：terminal ｜ 依赖：ANS-T07, T0-T08

## 目标
用 DPG `draw_text` 逐行渲染 ScreenBuffer：只渲染 dirty_rows + 可见区（虚拟化），CJK 宽字符对齐。

## IMPL `[详细]`

### 签名
```python
class TerminalViewport:
    def __init__(self, app_context: AppContext): ...
    def set_buffer(self, buf: ScreenBuffer) -> None: ...
    def render(self) -> None: ...
        # 每帧调用：清 drawlist，对 dirty 行逐 Cell draw_text
    def cell_size(self) -> tuple[float, float]: ...
        # (字宽, 行高)，由字体度量得出
```

### 关键设计
- 每帧只画 `get_dirty_rows()` 交集可见区，画完 `clear_dirty()`。
- 每行用一个 drawlist，多色 → 按连续同色段合并 draw_text 调用（减少调用数）。
- CJK 宽字符跳过占位列，按 2 倍字宽定位。
- 虚拟化：只画可见行范围，超出裁剪。

### 易错点
- **draw_text 调用数**：多色行若每个 Cell 一次调用会爆，需按同色段合并（T0-T08 spike 验证）。
- CJK 定位：宽字符起点 = col*字宽，但渲染时占位列不画。
- 滚动/脏标记刷新时序：dirty 在引擎线程清，GUI 线程只读——需双缓冲同步（ADR-0015）。

### 完成标准（DoD）
- [ ] 渲染一屏彩色文本正确（颜色/粗体/反色）
- [ ] CJK 对齐无错位
- [ ] 只画 dirty 行（性能断言：不刷全屏）
- [ ] 3Mbps 注入帧率稳定（复用 spike 基准）

## 禁止事项
- 不接键盘输入（TERM-T02）；不实现终端模拟逻辑（ansi 已做）
