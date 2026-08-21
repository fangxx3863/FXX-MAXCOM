//! UDP 客户端传输（TP-T07）：connect 固定对端，收发同一 socket。

use super::{ConnPair, TransportRead, TransportWrite};
use std::io;
use std::net::UdpSocket;
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_millis(50);

pub fn open(host: &str, port: u16) -> io::Result<ConnPair> {
    let addr = format!("{host}:{port}");
    let sock = UdpSocket::bind("0.0.0.0:0")?;
    sock.connect(&addr)?;
    sock.set_read_timeout(Some(READ_TIMEOUT))?;
    let write_half = sock.try_clone()?;
    Ok(ConnPair {
        read: Box::new(UdpRead { sock }),
        write: Box::new(UdpWrite { sock: write_half }),
        label: format!("UDP {addr}"),
    })
}

struct UdpRead {
    sock: UdpSocket,
}

impl TransportRead for UdpRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.sock.recv(buf) {
            Ok(n) => Ok(n),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut => Ok(0),
            Err(e) => Err(e),
        }
    }
}

struct UdpWrite {
    sock: UdpSocket,
}

impl TransportWrite for UdpWrite {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        self.sock.send(data).map(|_| ())
    }
}
