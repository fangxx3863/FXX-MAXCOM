# LOG-T01: 智能分包 + 时间戳

> 模块：logview ｜ 依赖：T0

## 目标
实现智能分包（空闲超时切分）+ 时间戳附加。独立开关（ADR-0008）。

## IMPL `[详细]`

### 签名
```python
@dataclass
class TimedFrame:
    timestamp_ms: int
    data: bytes

class TimestampManager:
    def __init__(self, idle_timeout_ms: int): ...
    def set_idle_timeout_ms(self, ms: int) -> None: ...
    def feed(self, data: bytes) -> list[TimedFrame]: ...
        # 追加到当前帧缓冲，空闲超时封包，返回已封的帧
    def flush(self) -> TimedFrame | None: ...
        # 强制封当前帧（连接关闭/清空时）
```

### 伪代码
```
feed(data):
    now = monotonic()
    if now - self._last_activity >= self._timeout and self._buf:
        frames.append(封包())
    self._buf += data
    self._last_activity = now
    if now - self._last_activity >= self._timeout:
        frames.append(封包())      # 数据中途空闲也切分
    return frames
```

### 易错点
- 空闲计时用 `time.monotonic()`（不受系统时间调整影响）。
- 开关关闭时：不封包，直接透传（或按行加简单时间戳）。
- 超时判定在 feed 与独立定时器双路径（数据流空闲时也要封包）。

### 完成标准（DoD）
- [ ] 空闲超时封包正确（数据中途空闲切分）
- [ ] 开关关闭透传
- [ ] 时间戳三种格式（绝对/相对/差值）生成正确
- [ ] flush 封当前帧

## 禁止事项
- 分包是日志路径本地行为，不改原始流（ADR-0015）
