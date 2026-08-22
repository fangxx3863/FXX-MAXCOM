//! 串口传输 + 枚举（TP-T02）。`serialport` crate 封装；仅 Windows/装了 libudev 的 Linux 编译。

use super::{ConnConfig, ConnPair, Parity, PortInfo, StopBits, TransportRead, TransportWrite};
use std::io::{self, ErrorKind};
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_millis(50);

pub fn discover() -> Vec<PortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| PortInfo {
            description: match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => info
                    .product
                    .clone()
                    .or_else(|| info.manufacturer.clone())
                    .unwrap_or_default(),
                _ => String::new(),
            },
            device: p.port_name,
        })
        .collect()
}

pub fn open(config: &ConnConfig) -> io::Result<ConnPair> {
    let ConnConfig::Serial {
        port,
        baud,
        data_bits,
        parity,
        stop_bits,
        flow_control,
    } = config
    else {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "not a serial config",
        ));
    };
    // serialport 4.x：serialport::new(path, baud) 链式构建，open() 打开内置路径
    let port_obj = serialport::new(port.as_str(), *baud)
        .data_bits(match *data_bits {
            5 => serialport::DataBits::Five,
            6 => serialport::DataBits::Six,
            7 => serialport::DataBits::Seven,
            _ => serialport::DataBits::Eight,
        })
        .parity(match parity {
            Parity::None => serialport::Parity::None,
            Parity::Even => serialport::Parity::Even,
            Parity::Odd => serialport::Parity::Odd,
        })
        .stop_bits(match stop_bits {
            StopBits::One => serialport::StopBits::One,
            StopBits::Two => serialport::StopBits::Two,
        })
        .flow_control(match flow_control {
            super::FlowControl::None => serialport::FlowControl::None,
            super::FlowControl::Software => serialport::FlowControl::Software,
            super::FlowControl::Hardware => serialport::FlowControl::Hardware,
        })
        .timeout(READ_TIMEOUT)
        .open()?; // From<serialport::Error> for io::Error
    let write_half = port_obj
        .try_clone()
        .map_err(|e| io::Error::other(e.to_string()))?;
    let label = format!("串口 {port} @ {baud}");
    Ok(ConnPair {
        read: Box::new(SerialRead { port: port_obj }),
        write: Box::new(SerialWrite { port: write_half }),
        label,
    })
}

struct SerialRead {
    port: Box<dyn serialport::SerialPort>,
}

impl TransportRead for SerialRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.port.read(buf) {
            Ok(n) => Ok(n),
            Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => Ok(0),
            Err(e) => Err(e),
        }
    }
}

struct SerialWrite {
    port: Box<dyn serialport::SerialPort>,
}

impl TransportWrite for SerialWrite {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        // 部分写入重试：部分 USB 虚拟串口驱动（WCH/CH34x 等）在内部 FIFO 满时
        // 返回短写甚至 Ok(0)/超时，std write_all 会报错或静默丢数据（大文件场景）。
        let mut rest = data;
        let mut stalled_ms = 0u32;
        while !rest.is_empty() {
            let progress = match self.port.write(rest) {
                Ok(0) => None,
                Ok(n) => Some(n),
                Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {
                    None
                }
                Err(e) => return Err(e),
            };
            match progress {
                Some(n) => {
                    rest = &rest[n..];
                    stalled_ms = 0;
                }
                None => {
                    std::thread::sleep(Duration::from_millis(1));
                    stalled_ms += 1;
                    if stalled_ms > 5000 {
                        return Err(io::Error::new(io::ErrorKind::WriteZero, "串口写持续无进展"));
                    }
                }
            }
        }
        Ok(())
    }

    fn set_dtr(&mut self, on: bool) -> io::Result<()> {
        self.port
            .write_data_terminal_ready(on)
            .map_err(io::Error::from)
    }

    fn set_rts(&mut self, on: bool) -> io::Result<()> {
        self.port.write_request_to_send(on).map_err(io::Error::from)
    }
}
