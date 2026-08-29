//! 传输层抽象与实现（TP-T01/T02/T06/T07）。
//!
//! 单连接 + 多实例（ADR-0016）：每个 Session 持有一个传输。
//! 串口走 `serialport` crate（feature `serial`，Windows 目标默认启用）；
//! TCP/UDP 用 std，全平台可测。

#[cfg(feature = "rtt")]
pub mod flashing;
#[cfg(feature = "usb")]
pub mod hid;
#[cfg(feature = "rtt")]
pub mod rtt;
#[cfg(feature = "serial")]
pub mod serial;
pub mod ssh;
pub mod tcp;
pub mod telnet;
pub mod udp;
#[cfg(feature = "usb")]
pub mod winusb;

use serde::{Deserialize, Serialize};
use std::io;

/// 连接配置 DTO（对齐 transport.schema.json；serde tag = "type"）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnConfig {
    Serial {
        port: String,
        #[serde(default = "default_baud")]
        baud: u32,
        #[serde(default = "default_data_bits")]
        data_bits: u8,
        #[serde(default = "default_parity")]
        parity: Parity,
        #[serde(default = "default_stop_bits")]
        stop_bits: StopBits,
        #[serde(default)]
        flow_control: FlowControl,
    },
    TcpClient {
        host: String,
        port: u16,
    },
    UdpClient {
        host: String,
        port: u16,
    },
    Ssh {
        host: String,
        port: u16,
        username: String,
        #[serde(default)]
        password: String,
    },
    Telnet {
        host: String,
        port: u16,
    },
    /// probe-rs RTT（仅 `rtt` feature 编译时可用传输；枚举始终存在以便序列化）
    Rtt {
        /// 探针选择器（"VID:PID" 或 "VID:PID:serial"，空 = 第一个探针）
        #[serde(default)]
        probe_selector: String,
        /// 目标芯片名，如 "nrf52840"、"rp2040"、"stm32f103ct6"；空或 "auto" → probe-rs 自动识别
        chip: String,
        /// up 通道（目标→主机，打印输出）
        #[serde(default = "default_channel")]
        up_channel: u32,
        /// down 通道（主机→目标，发送）；默认与 up 相同
        #[serde(default = "default_channel")]
        down_channel: u32,
        /// RTT 控制块起始地址（可选；提供后跳过扫描）
        #[serde(default)]
        rtt_address: Option<u64>,
    },
    /// WinUSB/libusb 类原始 USB 传输（nusb；仅 `usb` feature 编译时可用）
    Winusb {
        vid: u16,
        pid: u16,
        /// 接口号；None = 自动挑选第一个含 bulk/interrupt 数据端点的接口
        #[serde(default)]
        interface: Option<u8>,
        /// OUT 端点地址（如 0x01）；0 = 自动（优先 bulk、回退 interrupt）
        #[serde(default)]
        out_ep: u8,
        /// IN 端点地址（如 0x81）；0 = 自动（优先 bulk、回退 interrupt）
        #[serde(default)]
        in_ep: u8,
    },
    /// HID 传输（hidapi；仅 `usb` feature 编译时可用）
    Hid {
        vid: u16,
        pid: u16,
        /// 序列号（同 VID:PID 多设备时用于精确匹配；空 = 取第一个匹配设备）
        #[serde(default)]
        serial: Option<String>,
        /// 写时前置的 Report ID（单报告设备为 0）
        #[serde(default)]
        report_id: u8,
        /// 读时是否剥掉首字节 Report ID（单报告设备首字节恒为 0x00）
        #[serde(default = "default_strip_report_id")]
        strip_report_id: bool,
    },
}

fn default_strip_report_id() -> bool {
    true
}

fn default_baud() -> u32 {
    115200
}
fn default_data_bits() -> u8 {
    8
}
fn default_parity() -> Parity {
    Parity::None
}
fn default_stop_bits() -> StopBits {
    StopBits::One
}
fn default_channel() -> u32 {
    0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Parity {
    #[default]
    None,
    Even,
    Odd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum StopBits {
    #[serde(rename = "1")]
    #[default]
    One,
    #[serde(rename = "2")]
    Two,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FlowControl {
    #[default]
    None,
    Software,
    Hardware,
}

/// 发现串口信息（P4 端口页枚举用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub device: String,
    pub description: String,
}

/// 枚举到的 USB 接口信息（winusb 设备下拉：选设备后选接口）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsbInterfaceInfo {
    pub number: u8,
    pub class: u8,
    pub subclass: u8,
    pub protocol: u8,
}

/// 枚举到的 USB 设备（winusb 设备下拉用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsbDeviceInfo {
    pub vid: u16,
    pub pid: u16,
    pub manufacturer: String,
    pub product: String,
    pub serial: String,
    pub interfaces: Vec<UsbInterfaceInfo>,
}

/// 枚举到的 HID 设备（hid 设备下拉用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HidDeviceInfo {
    pub vid: u16,
    pub pid: u16,
    pub manufacturer: String,
    pub product: String,
    pub serial: String,
    pub usage_page: u16,
    pub usage: u16,
    pub interface_number: i32,
}

/// 串口文件传输协议（烧录页 BL 交互用：X/Y/ZMODEM）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ModemProtocol {
    #[default]
    Xmodem,
    Ymodem,
    Zmodem,
}

#[cfg(feature = "rtt")]
pub use flashing::FlashConfig;
#[cfg(feature = "rtt")]
pub use rtt::{ChipFamilyInfo, ProbeInfo};

/// 串口文件传输（X/Y/ZMODEM）：仅在 serial feature 下编译（依赖 serialport + 协议 crate）。
#[cfg(feature = "serial")]
pub mod modem;
#[cfg(feature = "serial")]
pub use modem::{run_modem_flash, ModemFlashConfig, ModemProgress};

/// 读取端：阻塞读，Ok(0) 表示本次超时无数据（作为空闲判定节拍）。
pub trait TransportRead: Send {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>;
}

/// 写入端：独立句柄（TCP/UDP clone、串口 try_clone），与读端互不阻塞。
pub trait TransportWrite: Send {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()>;

    /// DTR 引脚（仅串口有意义；其余传输 no-op）
    fn set_dtr(&mut self, _on: bool) -> io::Result<()> {
        Ok(())
    }

    /// RTS 引脚（仅串口有意义；其余传输 no-op）
    fn set_rts(&mut self, _on: bool) -> io::Result<()> {
        Ok(())
    }
}

/// 断线占位写端：自动重连期间替换掉旧写句柄（释放底层设备），send 报错直至重连成功。
pub struct DeadWrite;

impl TransportWrite for DeadWrite {
    fn write_all(&mut self, _data: &[u8]) -> io::Result<()> {
        Err(io::Error::other("未连接（自动重连中）"))
    }
}

/// 打开一次连接产出（读端 + 写端）。
pub struct ConnPair {
    pub read: Box<dyn TransportRead>,
    pub write: Box<dyn TransportWrite>,
    pub label: String,
}

/// 打开连接（按配置分发）。串口未编译 feature 时返回明确错误。
pub fn open(config: &ConnConfig) -> io::Result<ConnPair> {
    match config {
        ConnConfig::TcpClient { host, port } => tcp::open(host, *port),
        ConnConfig::UdpClient { host, port } => udp::open(host, *port),
        ConnConfig::Ssh {
            host,
            port,
            username,
            password,
        } => ssh::open(host, *port, username, password),
        ConnConfig::Telnet { host, port } => telnet::open(host, *port),
        #[cfg(feature = "rtt")]
        ConnConfig::Rtt {
            probe_selector,
            chip,
            up_channel,
            down_channel,
            rtt_address,
        } => rtt::open(
            probe_selector,
            chip,
            *up_channel as usize,
            *down_channel as usize,
            *rtt_address,
        ),
        #[cfg(not(feature = "rtt"))]
        ConnConfig::Rtt { .. } => Err(io::Error::other(
            "rtt support not compiled (feature \"rtt\")",
        )),
        #[cfg(feature = "serial")]
        ConnConfig::Serial { .. } => serial::open(config),
        #[cfg(not(feature = "serial"))]
        ConnConfig::Serial { .. } => Err(io::Error::other(
            "serial support not compiled (feature \"serial\")",
        )),
        #[cfg(feature = "usb")]
        ConnConfig::Winusb {
            vid,
            pid,
            interface,
            out_ep,
            in_ep,
        } => winusb::open(*vid, *pid, *interface, *out_ep, *in_ep),
        #[cfg(not(feature = "usb"))]
        ConnConfig::Winusb { .. } => Err(io::Error::other(
            "usb support not compiled (feature \"usb\")",
        )),
        #[cfg(feature = "usb")]
        ConnConfig::Hid {
            vid,
            pid,
            serial,
            report_id,
            strip_report_id,
        } => hid::open(*vid, *pid, serial.as_deref(), *report_id, *strip_report_id),
        #[cfg(not(feature = "usb"))]
        ConnConfig::Hid { .. } => Err(io::Error::other(
            "usb support not compiled (feature \"usb\")",
        )),
    }
}

/// 枚举串口。非串口 feature / 无端口 → 空列表，绝不抛异常。
pub fn discover_serial_ports() -> Vec<PortInfo> {
    #[cfg(feature = "serial")]
    {
        serial::discover()
    }
    #[cfg(not(feature = "serial"))]
    {
        Vec::new()
    }
}

/// 枚举调试探针。非 rtt feature / 无探针 → 空列表，绝不抛异常。
#[cfg(feature = "rtt")]
pub fn discover_probes() -> Vec<ProbeInfo> {
    rtt::discover_probes()
}

/// 列出 probe-rs 内置支持的目标芯片（家族 → 变体）。非 rtt feature → 空列表。
#[cfg(feature = "rtt")]
pub fn chip_list() -> Vec<ChipFamilyInfo> {
    rtt::chip_list()
}

/// 枚举 USB 设备（winusb 传输的设备下拉）。非 usb feature / 无设备 → 空列表，绝不抛异常。
pub fn discover_usb_devices() -> Vec<UsbDeviceInfo> {
    #[cfg(feature = "usb")]
    {
        winusb::discover()
    }
    #[cfg(not(feature = "usb"))]
    {
        Vec::new()
    }
}

/// 枚举 HID 设备（hid 传输的设备下拉）。非 usb feature / 无设备 → 空列表，绝不抛异常。
pub fn discover_hid_devices() -> Vec<HidDeviceInfo> {
    #[cfg(feature = "usb")]
    {
        hid::discover()
    }
    #[cfg(not(feature = "usb"))]
    {
        Vec::new()
    }
}

impl ConnConfig {
    /// 参数校验（连接前调用；非法返回 Err）
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ConnConfig::Serial { port, baud, .. } => {
                if port.is_empty() {
                    return Err("串口未选择".into());
                }
                if *baud < 300 {
                    return Err(format!("非法波特率: {baud}"));
                }
                Ok(())
            }
            ConnConfig::TcpClient { host, port }
            | ConnConfig::UdpClient { host, port }
            | ConnConfig::Ssh { host, port, .. }
            | ConnConfig::Telnet { host, port } => {
                if host.is_empty() {
                    return Err("主机为空".into());
                }
                if *port == 0 {
                    return Err(format!("非法端口: {port}"));
                }
                Ok(())
            }
            ConnConfig::Rtt { .. } => {
                // 空芯片名 / "auto" → probe-rs 自动识别目标芯片，无需强制填写
                Ok(())
            }
            ConnConfig::Winusb { vid, pid, .. } => {
                if *vid == 0 {
                    return Err("USB VID 无效（未选择设备）".into());
                }
                if *pid == 0 {
                    return Err("USB PID 无效（未选择设备）".into());
                }
                Ok(())
            }
            ConnConfig::Hid { vid, pid, .. } => {
                if *vid == 0 {
                    return Err("HID VID 无效（未选择设备）".into());
                }
                if *pid == 0 {
                    return Err("HID PID 无效（未选择设备）".into());
                }
                Ok(())
            }
        }
    }
}
