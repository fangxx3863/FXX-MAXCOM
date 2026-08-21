//! TCP 客户端传输（TP-T06）。

use super::{ConnPair, TransportRead, TransportWrite};
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_millis(50);

pub fn open(host: &str, port: u16) -> io::Result<ConnPair> {
    let addr = format!("{host}:{port}");
    let stream = TcpStream::connect(&addr)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_nodelay(true)?;
    let write_half = stream.try_clone()?;
    Ok(ConnPair {
        read: Box::new(TcpRead { stream }),
        write: Box::new(TcpWrite { stream: write_half }),
        label: format!("TCP {addr}"),
    })
}

struct TcpRead {
    stream: TcpStream,
}

impl TransportRead for TcpRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.stream.read(buf) {
            // 对端正常关闭（EOF）→ 报错，交给上层自动重连
            Ok(0) => Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed by peer")),
            Ok(n) => Ok(n),
            // 读超时 = 本节拍无数据（对齐 pyserial timeout 语义）
            Err(e)
                if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut =>
            {
                Ok(0)
            }
            Err(e) => Err(e),
        }
    }
}

struct TcpWrite {
    stream: TcpStream,
}

impl TransportWrite for TcpWrite {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        self.stream.write_all(data)
    }
}
