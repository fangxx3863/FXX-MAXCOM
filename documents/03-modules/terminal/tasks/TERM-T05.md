# TERM-T05: 粘贴（逐行 + 延迟）

> 模块：terminal ｜ 依赖：TERM-T02

## 目标
实现粘贴多行文本：逐行发送 + 可配置延迟（默认 10ms/行，ADR-0009）。

## IMPL `[详细]`

### 签名
```python
class PasteManager:
    def __init__(self, send: Callable[[bytes], None]): ...
    def set_delay_ms(self, ms: int) -> None: ...
    def paste(self, text: str) -> None: ...
        # 将 text 按行拆分，逐行入队发送，行间延迟
```

### 关键设计
- 逐行拆分发到发送队列，行间 `delay_ms`。
- 需与击键直传协调：粘贴期间按键不插入。
- 用户可中止粘贴（Esc）。

### 易错点
- 延迟用 I/O 线程或发送队列的计时，不能阻塞 GUI 线程。
- 空行保留；行尾换行形式按发送配置（ADR-0014）。

### 完成标准（DoD）
- [ ] 多行文本逐行发送、行间延迟正确
- [ ] 粘贴可中止
- [ ] 不阻塞 GUI（用 mock 断言发送时序）

## 禁止事项
- 一次性批量发送大文本（会溢出远端缓冲）
