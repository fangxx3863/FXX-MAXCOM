# LOG-T03: 日志引擎组装

> 模块：logview ｜ 依赖：LOG-T01, COLOR-T01, FLT-T01

## 目标
组装日志引擎：原始流 → 分包+时间戳 → 分行 → 染色 → 过滤 → 产出 LogEntry。在独立后台线程运行（ADR-0015）。

## IMPL `[详细]`

### 签名
```python
class LogEngine:
    def __init__(self, bus: EventBus, colorize: ColorizeEngine,
                 filter: FilterEngine, encoding: EncodingDetector): ...
    def run(self) -> None: ...   # 后台线程入口：从 bus 订阅原始流，循环消费
    def on_frame(self, frame: TimedFrame) -> None: ...
```

### 伪代码
```
run():
    q = bus.subscribe("logview")
    while running:
        data = q.get()
        for frame in ts.feed(data):           # 分包+时间戳
            for raw_line in splitter.feed(frame.data):  # 分行
                text = encoding.decode(raw_line)
                segments = colorize.process_line(text)
                entry = LogEntry(frame.timestamp_ms, text, raw_line, segments)
                if filter.should_show(text):   # 过滤（显示判定）
                    emit_to_viewport(entry)
                maybe_persist(entry)           # 落盘（见 LOG-T06 / O2）
```

### 完成标准（DoD）
- [ ] 完整链路：原始流 → LogEntry（带时间戳/颜色）
- [ ] 后台线程消费不阻塞 I/O
- [ ] 过滤隐藏行不显示
- [ ] 染色标签正确

## 禁止事项
- 不改原始流；不依赖其他引擎结果
