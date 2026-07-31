# TP-T04: 热插拔检测

> 模块：transport ｜ 依赖：TP-T02

## 目标
检测串口设备插拔，自动刷新端口列表；正在使用的端口断开则提示（重连见 TP-T05）。

## IMPL `[骨架]`

### 签名
```python
class HotplugWatcher:
    def __init__(self, registry: PortRegistry, on_change: Callable[[], None]): ...
    def start(self) -> None: ...
    def stop(self) -> None: ...
    # 轮询 list_serial_ports，对比端口集合变化
```

### 完成标准（DoD）
- [ ] 插拔自动刷新列表（事件回调）
- [ ] 正在使用端口断开触发 on_disconnect → 重连（TP-T05）

## 禁止事项
- 热插拔轮询间隔避免过频（≥1s）
