//! 传输层抽象与实现（TP-T01/T02/T06/T07）。
//!
//! 单连接 + 多实例（ADR-0016）：每个 Session 持有一个传输。
//! 串口走 `serialport` crate（feature `serial`，Windows 目标默认启用）；
//! TCP/UDP 用 std，全平台可测。

#[cfg(feature = "serial")]
pub mod serial;
pub mod tcp;
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

/// 读取端：阻塞读，Ok(0) 表示本次超时无数据（作为空闲判定节拍）。
pub trait TransportRead: Send {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>;
}

/// 写入端：独立句柄（TCP/UDP clone、串口 try_clone），与读端互不阻塞。
pub trait TransportWrite: Send {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()>;
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
        return serial::discover();
    }
    #[cfg(not(feature = "serial"))]
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
            ConnConfig::TcpClient { host, port } | ConnConfig::UdpClient { host, port } => {
                if host.is_empty() {
                    return Err("主机为空".into());
                }
                if *port == 0 {
                    return Err(format!("非法端口: {port}"));
                }
                Ok(())
            }
        }
    }
}
