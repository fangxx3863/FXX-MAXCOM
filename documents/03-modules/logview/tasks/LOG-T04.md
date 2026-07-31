# LOG-T04: 日志缓冲上限

> 模块：logview ｜ 依赖：LOG-T02

## 目标
实现 LogBuffer 固定上限 10 万行，超出丢弃旧行（ADR-0010）。

## IMPL `[骨架]`

### 签名
```python
class LogBuffer:
    MAX_LINES = 100_000
    def __init__(self): ...
    def append(self, entry: LogEntry) -> None: ...
    def view(self, offset: int, count: int) -> list[LogEntry]: ...   # 分页读取
    def clear(self) -> None: ...
    def __len__(self) -> int: ...
```

### 完成标准（DoD）
- [ ] 超上限丢最旧行
- [ ] 分页读取正确
- [ ] clear 生效
