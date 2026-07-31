# LOG-T02: 分行 + LogEntry

> 模块：logview ｜ 依赖：LOG-T01

## 目标
实现 `\r\n` / `\n` / `\r` 分行，构造 LogEntry（时间戳 + 文本 + 颜色标签 + 原始字节）。分行**不依赖分包**（ADR-0014）。

## IMPL `[详细]`

### 签名
```python
@dataclass
class LogEntry:
    timestamp_ms: int
    text: str
    raw: bytes
    segments: list[ColoredSegment] | None = None   # 染色后填充

class LineSplitter:
    def __init__(self): ...
    def feed(self, data: bytes) -> list[bytes]:
        # 按 \r\n / \n / \r 拆行，保留跨片段待续行
    def flush(self) -> list[bytes]: ...   # 未尾随换行的残余行
```

### 易错点
- **跨 TCP/分包边界**：行可能被截断，splitter 需持有未完成行（有状态）。
- `\r\n` 与单独 `\r`、`\n` 三种都要处理（DOS/Unix/Mac 换行）。
- 空行保留。

### 完成标准（DoD）
- [ ] 三种换行形式分行正确
- [ ] 跨片段拼行正确（残余行续接）
- [ ] flush 处理无尾随换行的行

## 禁止事项
- 分行不依赖分包；分包只加时间戳（两件事解耦）
