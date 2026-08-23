//! 传输层抽象与实现（TP-T01/T02/T06/T07）。
//!
//! 单连接 + 多实例（ADR-0016）：每个 Session 持有一个传输。
//! 串口走 `serialport` crate（feature `serial`，Windows 目标默认启用）；
//! TCP/UDP 用 std，全平台可测。

#[cfg(feature = "rtt")]
pub mod flashing;
#[cfg(feature = "rtt")]
pub mod rtt;
#[cfg(feature = "serial")]
pub mod serial;
pub mod ssh;
pub mod tcp;
pub mod telnet;
pub mod udp;

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

/// 发现的串口信息（P4 端口页枚举用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub device: String,
    pub description: String,
}

#[cfg(feature = "rtt")]
pub use flashing::FlashConfig;
#[cfg(feature = "rtt")]
pub use rtt::{ChipFamilyInfo, ProbeInfo};

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
        }
    }
}
