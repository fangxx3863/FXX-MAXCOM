//! 串口传输 + 枚举（TP-T02）。`serialport` crate 封装；仅 Windows/装了 libudev 的 Linux 编译。

use super::{ConnConfig, ConnPair, Parity, PortInfo, StopBits, TransportRead, TransportWrite};
use std::io::{self, ErrorKind};
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_millis(50);

pub fn discover() -> Vec<PortInfo> {
    match serialport::available_ports() {
        Ok(ports) => ports,
        Err(_) => Vec::new(),
    }
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
    let ConnConfig::Serial { port, baud, data_bits, parity, stop_bits, flow_control } = config else {
        return Err(io::Error::new(ErrorKind::InvalidInput, "not a serial config"));
    };
    let builder = serialport::Builder::new()
        .baud_rate(*baud)
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
        .timeout(READ_TIMEOUT);
    let port_obj = builder.open_path(port)?;
    let write_half = port_obj.try_clone().map_err(|e| io::Error::other(e.to_string()))?;
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
        self.port.write_all(data)
    }
}
