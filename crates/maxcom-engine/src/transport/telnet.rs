//! Telnet 传输：使用现成的 `telnet` crate 处理 IAC 协商与数据转义。
//!
//! 同一个 `Telnet` 实例由读/写两端通过 `Arc<Mutex<_>>` 共享；
//! 读取超时约 50ms，作为会话心跳节拍返回 `Ok(0)`。

use super::{ConnPair, TransportRead, TransportWrite};
use std::io::{self, ErrorKind};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use telnet::{Event, Telnet};

const READ_TIMEOUT: Duration = Duration::from_millis(50);
const BUF_SIZE: usize = 4096;

pub fn open(host: &str, port: u16) -> io::Result<ConnPair> {
    let addr = format!("{host}:{port}");
    let telnet = Telnet::connect(&addr[..], BUF_SIZE)?;
    let telnet = Arc::new(Mutex::new(telnet));
    Ok(ConnPair {
        read: Box::new(TelnetRead {
            telnet: Arc::clone(&telnet),
            pending: Vec::new(),
        }),
        write: Box::new(TelnetWrite { telnet }),
        label: format!("Telnet {addr}"),
    })
}

struct TelnetRead {
    telnet: Arc<Mutex<Telnet>>,
    pending: Vec<u8>,
}

impl TransportRead for TelnetRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.pending.is_empty() {
            let n = self.pending.len().min(buf.len());
            buf[..n].copy_from_slice(&self.pending[..n]);
            self.pending.drain(..n);
            return Ok(n);
        }

        let mut telnet = self
            .telnet
            .lock()
            .map_err(|_| io::Error::other("telnet mutex poisoned"))?;

        loop {
            match telnet.read_timeout(READ_TIMEOUT) {
                Ok(Event::Data(data)) => {
                    let n = data.len().min(buf.len());
                    buf[..n].copy_from_slice(&data[..n]);
                    if n < data.len() {
                        self.pending.extend_from_slice(&data[n..]);
                    }
                    return Ok(n);
                }
                Ok(Event::TimedOut) | Ok(Event::NoData) => return Ok(0),
                Ok(Event::Negotiation(_, _))
                | Ok(Event::Subnegotiation(_, _))
                | Ok(Event::UnknownIAC(_)) => continue,
                Ok(Event::Error(telnet::TelnetError::InternalQueueErr)) => {
                    return Err(io::Error::new(
                        ErrorKind::UnexpectedEof,
                        "telnet connection closed",
                    ));
                }
                Ok(Event::Error(e)) => {
                    return Err(io::Error::other(format!("telnet 协议错误: {e}")));
                }
                Err(e) => return Err(e),
            }
        }
    }
}

struct TelnetWrite {
    telnet: Arc<Mutex<Telnet>>,
}

impl TransportWrite for TelnetWrite {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        let mut telnet = self
            .telnet
            .lock()
            .map_err(|_| io::Error::other("telnet mutex poisoned"))?;

        let mut written = 0;
        while written < data.len() {
            let n = telnet.write(&data[written..])?;
            if n == 0 {
                return Err(io::Error::new(ErrorKind::WriteZero, "telnet 写入 0 字节"));
            }
            written += n;
        }
        Ok(())
    }
}
