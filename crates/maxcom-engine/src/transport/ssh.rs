//! SSH 传输：基于 `russh`（纯 Rust，默认 `ring` 后端）实现。
//!
//! 为什么用 `russh` 而不是 `ssh2`/libssh2：
//! - libssh2 在 Windows 上默认走 WinCNG 后端，`LIBSSH2_ED25519=0`（无 curve25519 KEX）
//!   且 `LIBSSH2_ECDSA=0`（无 ecdh KEX），只剩 DH-Group KEX。
//! - 新一点的 OpenSSH 服务器（如 OpenSSH >= 10）默认**只**提供 curve25519 / ecdh /
//!   后量子 KEX，不再提供 DH-Group，于是两端 KEX 无交集 → “Unable to exchange
//!   encryption keys”。而现代 OpenSSH 客户端（pwsh 里的 ssh）用的就是 curve25519。
//! - `russh` 用纯 Rust 密码学（ring/aws-lc-rs），三平台行为一致，curve25519 / ecdh /
//!   post-quantum 都支持，能连新旧服务器。
//!
//! 认证优先级：显式密码（若提供）→ `~/.ssh` 下常用私钥。
//! 通道就绪后，读端按 50ms 心跳节拍返回 `Ok(0)`（会话引擎判断空闲/存活）。

use super::{ConnPair, TransportRead, TransportWrite};
use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{Channel, ChannelId, ChannelMsg};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

const READ_TIMEOUT_MS: u64 = 50;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

const KEY_NAMES: &[&str] = &["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

/// 主机密钥校验。此处暂接受所有（与既有实现一致）；
/// 后续可接入 known_hosts 校验。
struct Handler;

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// 读端一次 `block_on` 的结果。
enum Rx {
    Data(Vec<u8>),
    Timeout,
    Closed,
}

pub fn open(host: &str, port: u16, username: &str, password: &str) -> io::Result<ConnPair> {
    if username.trim().is_empty() {
        return Err(io::Error::other("SSH 用户名不能为空"));
    }

    let rt = Arc::new(tokio::runtime::Runtime::new().map_err(io::Error::other)?);

    let host_own = host.to_string();
    let user_own = username.to_string();
    let pass_own = password.to_string();

    // 连接 + 认证 + 建通道整体跑在一个多线程 runtime 里；用 block_on 把异步收敛回同步。
    // 注意：`tokio::time::timeout` 必须在进入 runtime 上下文后再构造（否则报 no reactor running）。
    let channel = rt.block_on(async move {
        tokio::time::timeout(CONNECT_TIMEOUT, async move {
            let config = Arc::new(client::Config::default());
            let mut session = client::connect(config, (host_own.as_str(), port), Handler)
                .await
                .map_err(|e| io::Error::other(format!("SSH 握手失败: {e}")))?;

            if !pass_own.is_empty() {
                let res = session
                    .authenticate_password(&user_own, pass_own.as_str())
                    .await
                    .map_err(|e| io::Error::other(format!("SSH 认证失败: {e}")))?;
                if !res.success() {
                    return Err(io::Error::other("SSH 密码认证失败"));
                }
            } else {
                // 无密码：尝试 ~/.ssh 下常用私钥
                authenticate_with_keys(&mut session, &user_own).await?;
            }

            let channel = session
                .channel_open_session()
                .await
                .map_err(|e| io::Error::other(format!("SSH 打开通道失败: {e}")))?;
            channel
                .request_pty(true, "xterm", 80, 24, 0, 0, &[])
                .await
                .map_err(|e| io::Error::other(format!("SSH 申请 pty 失败: {e}")))?;
            channel
                .request_shell(true)
                .await
                .map_err(|e| io::Error::other(format!("SSH 启动 shell 失败: {e}")))?;

            Ok::<_, io::Error>(channel)
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "SSH 连接超时"))?
    })?;

    let sh = Arc::new(Mutex::new(channel));

    let read: Box<dyn TransportRead> = Box::new(SshRead {
        ch: sh.clone(),
        rt: rt.clone(),
        pending: Vec::new(),
    });
    let write: Box<dyn TransportWrite> = Box::new(SshWrite { ch: sh, rt });

    Ok(ConnPair {
        read,
        write,
        label: format!("SSH {username}@{host}:{port}"),
    })
}

async fn authenticate_with_keys<H: client::Handler>(
    session: &mut client::Handle<H>,
    username: &str,
) -> io::Result<()> {
    let ssh_dir = home_dir().map(|h| h.join(".ssh"));
    let mut last_err: Option<String> = None;
    if let Some(dir) = ssh_dir {
        for name in KEY_NAMES {
            let path = dir.join(name);
            if !path.exists() {
                continue;
            }
            match load_secret_key(&path, None) {
                Ok(key) => {
                    let hash = session
                        .best_supported_rsa_hash()
                        .await
                        .ok()
                        .and_then(|h| h.flatten());
                    match session
                        .authenticate_publickey(
                            username,
                            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                        )
                        .await
                    {
                        Ok(res) if res.success() => return Ok(()),
                        Ok(_) => last_err = Some(format!("私钥 {name} 被拒绝")),
                        Err(e) => last_err = Some(format!("私钥 {name} 认证异常: {e}")),
                    }
                }
                Err(e) => last_err = Some(format!("读取私钥 {name} 失败: {e}")),
            }
        }
    }
    let msg = last_err.unwrap_or_else(|| "未找到可用私钥".into());
    Err(io::Error::other(format!(
        "SSH 认证失败: {msg}（已尝试密码/常用私钥；如需 SSH Agent 或 passphrase 私钥请补充 UI）"
    )))
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

struct SshRead<S>
where
    S: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
    ch: Arc<Mutex<Channel<S>>>,
    rt: Arc<tokio::runtime::Runtime>,
    pending: Vec<u8>,
}

impl<S> TransportRead for SshRead<S>
where
    S: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.pending.is_empty() {
            let n = self.pending.len().min(buf.len());
            buf[..n].copy_from_slice(&self.pending[..n]);
            self.pending.drain(..n);
            return Ok(n);
        }

        let ch = self.ch.clone();
        let rx = self.rt.handle().block_on(async move {
            let mut ch = ch.lock().await;
            loop {
                match tokio::time::timeout(Duration::from_millis(READ_TIMEOUT_MS), ch.wait()).await
                {
                    Ok(Some(ChannelMsg::Data { data })) => return Rx::Data(data.to_vec()),
                    Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                        // stderr 合并到终端输出
                        return Rx::Data(data.to_vec());
                    }
                    Ok(Some(_)) => continue,       // 其它控制消息，忽略
                    Ok(None) => return Rx::Closed, // 通道关闭
                    Err(_) => return Rx::Timeout,  // 心跳空闲
                }
            }
        });

        match rx {
            Rx::Data(data) => {
                let n = data.len().min(buf.len());
                buf[..n].copy_from_slice(&data[..n]);
                if n < data.len() {
                    self.pending.extend_from_slice(&data[n..]);
                }
                Ok(n)
            }
            Rx::Timeout => Ok(0), // 空闲节拍
            Rx::Closed => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "SSH channel closed",
            )),
        }
    }
}

struct SshWrite<S>
where
    S: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
    ch: Arc<Mutex<Channel<S>>>,
    rt: Arc<tokio::runtime::Runtime>,
}

impl<S> TransportWrite for SshWrite<S>
where
    S: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        let bytes = bytes::Bytes::copy_from_slice(data);
        let ch = self.ch.clone();
        self.rt
            .handle()
            .block_on(async move {
                let ch = ch.lock().await;
                ch.data_bytes(bytes).await
            })
            .map_err(io::Error::other)
    }
}
