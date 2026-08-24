# ADR-0019: USB 传输接口 —— WinUSB/libusb 原始传输 + HID

- 状态：**accepted**
- 日期：2026-08-25
- 裁决人：项目负责人（口头指令："利用 nusb，加两个通信接口，WinUSB/libusb 和 HID"）
- Supersedes：无
- 涉及契约：`documents/02-contracts/transport.schema.json`（type 枚举早已含 `winusb`/`hid`，本 ADR 补齐其载荷字段）

## 背景

`transport.schema.json` 的 `type` 枚举自始就预留了 `winusb` 与 `hid`（V2 §4.4 的 P1 Phase 4 能力），
但 Rust 引擎从未实现。本轮补上两个传输：

1. **winusb**：WinUSB/libusb 类原始 USB 传输 —— 在选定接口的 bulk / interrupt 端点上做原始字节流读写，
   面向自定义 USB 协议设备（vendor class 批量传输等）。
2. **hid**：HID 传输 —— 面向 HID 自定义报告设备（vendor usage page 调试通道、HID 桥接芯片等）。

## 决策

### 库选型

| 传输 | crate | 理由 |
|---|---|---|
| winusb | `nusb = "0.2"` | 纯 Rust USB 库：Windows 走 WinUSB API、Linux 走 usbfs、macOS 走 IOKit，与 libusb 语义等价且无需打包 libusb DLL。版本与 probe-rs 0.32 内部 pin 一致（工作区唯一副本）。 |
| hid | `hidapi = "2"` | **nusb 任何版本都不提供 HID 支持**（HID 由操作系统 HID 驱动栈管理，不在 WinUSB/libusb 层）。hidapi 是跨平台标准接入库，probe-rs 驱动 CMSIS-DAP v1 探针亦用它；Windows 走纯 Rust 原生后端，Linux 与 probe-rs 同为 basic-udev（hidraw）。 |

R7 技术栈锁以本 ADR 追加两枚 crate 入锁。

### 传输语义

- **winusb**：`interface` 省略时自动挑选第一个同时含 IN/OUT 数据端点（bulk 优先、interrupt 回退）的接口；
  `out_ep`/`in_ep` 为 0 时自动挑端点。读端 50ms 超时 → `Ok(0)` 空闲节拍（对齐其它传输）；写端 `write_all` 后 `flush` 提交
  （EndpointWrite 为缓冲写）。Windows 侧设备需 WinUSB/libusb 驱动（Zadig 可装）。
- **hid**：非阻塞读（无数据即 `Ok(0)` 空闲节拍，跨平台确定性）；写自动前置 Report ID；
  读默认剥掉首字节 Report ID（`strip_report_id`，单报告设备该字节恒为 0x00），可关。
  `serial` 非空时按序列号精确匹配（同 VID:PID 多设备场景）。负载长度不得超过设备报告长度。
- 两个传输都接入既有 `ConnConfig`（serde tag = "type"）与 `transport::open()` 分发，会话层零改动
  （自动重连、DTR/RTS 重放、捕获等既有机制天然适用）。

### feature 门控

- `maxcom-engine` 新增 feature `usb`（= nusb + hidapi）；桌面外壳 `desktop` feature 透传启用。
- 移动端不启用（Android 链接问题与既有 serial/rtt 同策略）。
- DTO（`UsbDeviceInfo`/`UsbInterfaceInfo`/`HidDeviceInfo`）定义在 `transport/mod.rs`（无条件编译，
  与 `PortInfo` 同款），枚举函数在未编译 feature 时返回空列表、绝不抛异常。

### 契约变更

`transport.schema.json` 的 `type` 枚举已含 `winusb`/`hid`（无需改枚举），新增载荷属性：
`vid`/`pid`（winusb+hid）、`interface`/`out_ep`/`in_ep`（winusb，均可选/可自动）、
`serial`/`report_id`/`strip_report_id`（hid）。`additionalProperties:false` 与 `required:["type"]` 不变。

## 后果

- 正面：串口/网络之外补齐 USB 原始通道与 HID 通道，覆盖自定义 USB 协议设备调试场景；
  两个传输共用会话层全部能力（日志/染色/过滤/绘图/捕获/自动重连）。
- 负面/风险：
  - winusb 依赖设备驱动状态，Windows 下未装 WinUSB/libusb 驱动时 open 报错（错误信息已提示 Zadig）。
  - HID 报告长度固定，长负载发送会被设备拒绝（错误信息已提示）。
  - `nusb::io::EndpointRead/Write` 为 0.2 新 API，若未来 nusb 大版本 API 变更需同步适配。
