# PLT-T01: RingBuffer + 数据源

> 模块：plot ｜ 依赖：T0

## 目标
实现环形缓冲区（原始字节缓存）+ 绘图数据源（订阅原始流）。

## IMPL `[详细]`

### 签名
```python
class RingBuffer:
    def __init__(self, capacity: int): ...
    def append(self, data: bytes) -> None: ...
    def read(self, offset: int, size: int) -> bytes: ...
    def available(self) -> int: ...
    def clear(self) -> None: ...

class PlotDataSource:
    def __init__(self, bus: EventBus): ...
    def run(self) -> None: ...   # 后台线程：订阅原始流，写入 ring buffer
```

### 完成标准（DoD）
- [ ] 环形覆盖正确
- [ ] 数据源订阅原始流（非分包流）
- [ ] 后台线程消费不阻塞 I/O

## 禁止事项
- 数据源不做解析（帧解析在 PLT-T02/03/04）
