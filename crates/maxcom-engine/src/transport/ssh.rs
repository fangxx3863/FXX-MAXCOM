//! SSH 传输：基于 `ssh2` / libssh2 crate 实现。
//!
//! 认证优先级：显式密码（若提供）→ SSH Agent → `~/.ssh` 下的常用私钥。
//! 通道使用 `libssh2` 的 50ms timeout，读取端按会话心跳节拍返回 `Ok(0)`。

use super::{ConnPair, TransportRead, TransportWrite};
use ssh2::Session;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

const READ_TIMEOUT_MS: u32 = 50;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

const KEY_NAMES: &[&str] = &["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

pub fn open(host: &str, port: u16, username: &str, password: &str) -> io::Result<ConnPair> {
    let addr = format!("{host}:{port}");
    if username.trim().is_empty() {
        return Err(io::Error::other("SSH 用户名不能为空"));
    }

    let stream = connect_with_timeout(host, port)?;
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(Duration::from_millis(u64::from(READ_TIMEOUT_MS))))?;
    stream.set_write_timeout(Some(Duration::from_millis(u64::from(READ_TIMEOUT_MS))))?;

    let mut sess = Session::new().map_err(io::Error::from)?;
    sess.set_tcp_stream(stream);
    sess.set_timeout(READ_TIMEOUT_MS);
    sess.handshake().map_err(io::Error::from)?;

    authenticate(&sess, username, password)?;

    let mut channel = sess.channel_session().map_err(io::Error::from)?;
    channel
        .request_pty("xterm", None, Some((80, 24, 0, 0)))
        .map_err(io::Error::from)?;
    channel.shell().map_err(io::Error::from)?;

    let write_channel = channel.clone();
    Ok(ConnPair {
        read: Box::new(SshRead {
            channel,
            pending: Vec::new(),
        }),
        write: Box::new(SshWrite {
            channel: write_channel,
        }),
        label: format!("SSH {username}@{addr}"),
    })
}

fn connect_with_timeout(host: &str, port: u16) -> io::Result<TcpStream> {
    use std::net::ToSocketAddrs;
    use std::time::Instant;

    let start = Instant::now();
    let mut last_err = io::Error::new(io::ErrorKind::Other, "no address resolved");
    for addr in (host, port).to_socket_addrs()? {
        if start.elapsed() >= CONNECT_TIMEOUT {
            return Err(last_err);
        }
        let remaining = CONNECT_TIMEOUT.saturating_sub(start.elapsed());
        match TcpStream::connect_timeout(&addr, remaining) {
            Ok(s) => return Ok(s),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn authenticate(sess: &Session, username: &str, password: &str) -> io::Result<()> {
    let mut last_err: Option<ssh2::Error> = None;

    if !password.is_empty() {
        match sess.userauth_password(username, password) {
            Ok(()) => return Ok(()),
            Err(e) if last_err.is_none() => last_err = Some(e),
            Err(_) => {}
        }
    }

    match sess.userauth_agent(username) {
        Ok(()) => return Ok(()),
        Err(e) if last_err.is_none() => last_err = Some(e),
        Err(_) => {}
    }

    let ssh_dir = home_dir().map(|h| h.join(".ssh"));
    if let Some(dir) = ssh_dir {
        for name in KEY_NAMES {
            let key = dir.join(name);
            if key.exists() {
                match sess.userauth_pubkey_file(username, None, &key, None) {
                    Ok(()) => return Ok(()),
                    Err(e) if last_err.is_none() => last_err = Some(e),
                    Err(_) => {}
                }
            }
        }
    }

    let mut msg = String::from("SSH 认证失败");
    if let Some(e) = last_err {
        msg.push_str(": ");
        msg.push_str(&e.to_string());
    }
    msg.push_str(
        "（已尝试密码/Agent/常用私钥；如需键盘交互或 passphrase 私钥请补充 UI 或使用 SSH Agent）",
    );
    Err(io::Error::other(msg))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOMEDRIVE")
                    .zip(std::env::var_os("HOMEPATH"))
                    .map(|(d, p)| {
                        PathBuf::from(format!("{}{}", d.to_string_lossy(), p.to_string_lossy()))
                    })
            })
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

struct SshRead {
    channel: ssh2::Channel,
    pending: Vec<u8>,
}

impl TransportRead for SshRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.pending.is_empty() {
            let n = self.pending.len().min(buf.len());
            buf[..n].copy_from_slice(&self.pending[..n]);
            self.pending.drain(..n);
            return Ok(n);
        }

        match self.channel.read(buf) {
            Ok(0) => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "SSH channel closed",
            )),
            Ok(n) => Ok(n),
            Err(e)
                if e.kind() == io::ErrorKind::TimedOut || e.kind() == io::ErrorKind::WouldBlock =>
            {
                Ok(0)
            }
            Err(e) => Err(e),
        }
    }
}

struct SshWrite {
    channel: ssh2::Channel,
}

impl TransportWrite for SshWrite {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        self.channel.write_all(data)
    }
}
