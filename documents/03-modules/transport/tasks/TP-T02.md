# TP-T02: 串口实现 + 发现枚举

> 模块：transport ｜ 依赖：TP-T01

## 目标
实现 SerialTransport（pyserial）与串口发现/枚举（端口 + 设备描述符名称）。

## IMPL `[详细]`

### 签名
```python
class SerialTransport(TransportBase):
    def __init__(self): ...
    def open(self, config: TransportConfig) -> None: ...
        # serial.Serial(port, baudrate, bytesize, parity, stopbits)
        # 启动读线程，on_data 回调发布原始流
    def read(self, size=4096) -> bytes: ...
    def write(self, data: bytes) -> int: ...
    def set_dtr_rts(self, dtr, rts) -> None: ...

def list_serial_ports() -> list[PortInfo]:
    # serial.tools.list_ports：返回 (port, description) 列表
    @dataclass
    class PortInfo:
        port: str            # "COM3"
        description: str     # "Silicon Labs CP210x USB to UART Bridge"
```

### 易错点
- 读线程阻塞在 `serial.read()`，断开时抛异常 → 捕获并触发 on_disconnect。
- Windows 端口名 `COM10+` 无冒号，pyserial 处理 OK。
- 别名/黑名单过滤在枚举层（TP-T03）。

### 完成标准（DoD）
- [ ] 打开/读写/关闭基本回路（com0com 虚拟串口对测试）
- [ ] 发现枚举返回端口 + 描述符
- [ ] 断开触发 on_disconnect

## 禁止事项
- 读线程不做解析，只发原始字节（INV-1）
