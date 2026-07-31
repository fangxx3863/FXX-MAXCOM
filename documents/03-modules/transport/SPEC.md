# 传输层模块（transport / TP）

> 状态：接近规格 ｜ 依赖：_foundation
> 对应 V2 §1.1 + §4.4。串口/TCP/UDP + 发现/枚举/生命周期。单连接 + 多实例（ADR-0016）。

## 1. 定位
传输层抽象：`TransportBase` 接口 + 各实现（串口/TCP/UDP，后续 WINUSB/HID）。I/O 线程读取原始字节流发布到事件总线（ADR-0015 的源头）。

## 2. 组件

### 2.1 TransportBase（base）
```python
class TransportBase(ABC):
    transport_type: TransportType
    def open(config) -> None
    def close() -> None
    def is_open() -> bool
    def read(size=4096) -> bytes
    def write(data) -> int
    def get_config() -> TransportConfig
    def set_dtr_rts(dtr, rts) -> None
    # 回调
    on_data / on_disconnect / on_error
```

### 2.2 实现
- **serial**：pyserial。波特率/数据位/停止位/校验位/流控。别名/记忆（全局配置）。
- **tcp_client / tcp_server / udp_client / udp_server**：socket。长连接、自动重连。
- **winusb / hid**（P1，Phase 4）：pywinusb / hidapi。

### 2.3 传输管理器（transport_manager）
- 发现/枚举：串口列表 + 设备描述符名称。
- 端口别名、黑名单、记忆上次配置（全局配置）。
- 热插拔检测（设备插拔自动刷新列表）。
- 自动重连（端口断开后重连，P0 需求）。

## 3. 关键不变量
- **INV-1**：I/O 线程只读原始字节流发布到事件总线，**不做任何解析/分包**。
- **INV-2**：write 走统一发送路径（终端击键 + 发送框共用）。
- **INV-3**：单连接；多端口 = 多实例（ADR-0016）。
- **INV-4**：读线程阻塞在 read，断开触发 on_disconnect → 自动重连逻辑。

## 4. 任务卡
| 卡 | 标题 | blocked-by |
|---|---|---|
| TP-T01 | TransportBase 抽象 + TransportConfig | T0-T03 |
| TP-T02 | 串口实现（pyserial）+ 发现枚举 | TP-T01 |
| TP-T03 | 端口别名/黑名单/记忆（全局配置） | TP-T02, T0-T06 |
| TP-T04 | 热插拔检测 | TP-T02 |
| TP-T05 | 自动重连（断开→重连） | TP-T02 |
| TP-T06 | TCP client/server 实现 | TP-T01 |
| TP-T07 | UDP client/server 实现 | TP-T01 |
| TP-T08 | 发送统一路径（write + 换行符配置） | TP-T01 |
