//! 会话文件传输（X/Y/ZMODEM）：烧录页 BL 交互用。
//!
//! 两种入口：
//! - `run_modem_flash`：自行打开串口（独立场景）。
//! - `run_modem_on`：在**已建立的会话连接**上做传输（复用顶栏连接，任意模式通用）。
//!   调用方负责提供全双工设备句柄 `D: Read + Write`（见 SessionManager::modem_transfer）。
//!
//! 为何需要 `Duplex`：本引擎所有传输的读/写是分离的 `Box<dyn TransportRead>` /
//! `Box<dyn TransportWrite>`，而 xmodem/ymodem 的 send API 要求**同一个** `D: Read + Write`
//! 对象既收 ACK 又发数据。故用 `Duplex` 把分离的两半合成一个全双工对象。
//!
//! 进度语义复用烧录进度事件：`kind` ∈ started|progress|message|finished|failed；
//! ZMODEM 为流式、无精确总量，用 `total=0` 表示不确定进度（前端显示 indeterminate）。

use crate::transport::ModemProtocol;
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 独立串口传输请求配置（自行打开串口场景）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModemFlashConfig {
    /// 串口设备名
    pub port: String,
    /// 波特率
    pub baud: u32,
    /// 协议
    pub protocol: ModemProtocol,
    /// 待发送固件文件绝对路径
    pub path: String,
}

/// 进度回调负载（复用烧录进度事件语义）。
pub struct ModemProgress {
    /// 事件类型：started | progress | message | finished | failed
    pub kind: &'static str,
    /// 阶段文案（协议名，如 "xmodem"）
    pub operation: String,
    /// 已处理字节
    pub size: u64,
    /// 操作总量（ZMODEM 用 0 表示不确定）
    pub total: u64,
    /// 附加消息（failed 详情 / 诊断）
    pub message: Option<String>,
}

/// 把分离的读/写半体合成为一个全双工 `Read + Write` 设备（供 xmodem/ymodem send 使用）。
///
/// 注意：`TransportRead::read` 把读超时转成了 `Ok(0)`，而 modem 协议把读超时视为错误
/// （计入 max_errors）。故这里把 `Ok(0)` 还原为 `TimedOut`，使协议正确处理超时；
/// 真实 EOF 在网络层会被 TransportRead 转成 `UnexpectedEof` 错误，不受影响。
///
/// `cancel` 是跨线程取消位：用户点击强制停止按钮时由命令层置位，各协议层（X/Y/Z）据此
/// 中断阻塞等待。X/Y 通过 `Read::read` 返回 `Interrupted` 被底层 crate 传播为致命错误；
/// Z 在主循环头部显式检查。
pub struct Duplex {
    pub read: Box<dyn crate::transport::TransportRead>,
    pub write: Box<dyn crate::transport::TransportWrite>,
    /// 跨线程取消位（Arc 克隆，命令层与传输层共享）
    pub cancel: Arc<AtomicBool>,
}

impl Read for Duplex {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // 取消位已置位：立即以 Interrupted 返回。xmodem/ymodem 把非超时读错误视为致命
        // （? 直接传播），从而被中断；zmodem 在主循环里另行显式检查。
        if self.cancel.load(Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        match self.read.read(buf) {
            Ok(0) => Err(io::Error::new(io::ErrorKind::TimedOut, "read timeout")),
            other => other,
        }
    }
}

impl Write for Duplex {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write.write_all(buf)?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 进度可读包装：在 Read 层累计已发字节并回调（X/YMODEM 用）。
struct ProgressReader<'a, R: Read> {
    inner: R,
    sent: u64,
    total: u64,
    cb: &'a dyn Fn(u64, u64),
}

impl<'a, R: Read> Read for ProgressReader<'a, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.sent += n as u64;
            (self.cb)(self.sent, self.total);
        }
        Ok(n)
    }
}

/// 打开独立串口（无流控 8N1，超时 500ms 让 modem 协议能感知对端无响应）。
fn open_port(port: &str, baud: u32) -> Result<Box<dyn serialport::SerialPort>, String> {
    serialport::new(port, baud)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .flow_control(serialport::FlowControl::None)
        .timeout(Duration::from_millis(500))
        .open()
        .map_err(|e| format!("打开串口失败: {e}"))
}

/// 入口（独立串口场景）：自行打开串口、跑协议、上报进度、关闭。
pub fn run_modem_flash(
    cfg: &ModemFlashConfig,
    on_progress: impl Fn(&ModemProgress),
) -> Result<(), String> {
    let port = open_port(&cfg.port, cfg.baud)?;
    let file = std::fs::File::open(&cfg.path).map_err(|e| format!("打开文件失败: {e}"))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let proto = cfg.protocol;
    let path = cfg.path.clone();
    // 独立串口场景暂无取消入口：给一个永假的取消位即可
    let cancel = Arc::new(AtomicBool::new(false));
    let mut duplex = Duplex {
        read: Box::new(SerialReadShim {
            port: port.try_clone().map_err(|e| e.to_string())?,
        }),
        write: Box::new(SerialWriteShim { port }),
        cancel: cancel.clone(),
    };
    run_modem_on(
        &mut duplex,
        proto,
        file,
        &path,
        total,
        &cancel,
        &on_progress,
    )
}

/// 在已实现 `Read + Write` 的设备上跑 modem 协议（会话/独立场景共用）。
///
/// `cancel` 为跨线程取消位（置位即中止传输）；用户强制停止时返回统一错误串 `"cancelled"`，
/// 调用方（前端）据此显示“已取消”而不是失败文案。取消不产生 failed 进度事件。
pub fn run_modem_on<D: Read + Write>(
    dev: &mut D,
    protocol: ModemProtocol,
    file: std::fs::File,
    path: &str,
    total: u64,
    cancel: &AtomicBool,
    on_progress: &impl Fn(&ModemProgress),
) -> Result<(), String> {
    let proto_name = format!("{protocol:?}").to_lowercase();
    on_progress(&ModemProgress {
        kind: "started",
        operation: proto_name.clone(),
        size: 0,
        total,
        message: None,
    });

    let res = match protocol {
        ModemProtocol::Xmodem => send_xmodem(dev, file, total, on_progress),
        ModemProtocol::Ymodem => send_ymodem(dev, file, path, total, on_progress),
        ModemProtocol::Zmodem => send_zmodem(dev, path, total, cancel, on_progress),
    };

    match res {
        Ok(()) => {
            on_progress(&ModemProgress {
                kind: "finished",
                operation: proto_name,
                size: total,
                total,
                message: None,
            });
            Ok(())
        }
        Err(e) => {
            // 用户取消：不当作失败事件上报，只把统一标记 "cancelled" 返回给调用方
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            on_progress(&ModemProgress {
                kind: "failed",
                operation: proto_name,
                size: 0,
                total,
                message: Some(e.clone()),
            });
            Err(e)
        }
    }
}

// ── XMODEM ──
fn send_xmodem<D: Read + Write>(
    dev: &mut D,
    file: std::fs::File,
    total: u64,
    on_progress: &impl Fn(&ModemProgress),
) -> Result<(), String> {
    let cb = |sent: u64, total: u64| {
        on_progress(&ModemProgress {
            kind: "progress",
            operation: "xmodem".into(),
            size: sent,
            total,
            message: None,
        });
    };
    let mut reader = ProgressReader {
        inner: file,
        sent: 0,
        total,
        cb: &cb,
    };
    let mut x = xmodem::Xmodem::new();
    x.send(dev, &mut reader)
        .map(|_bytes| ())
        .map_err(|e| format!("XMODEM 发送失败: {e:?}"))
}

// ── YMODEM ──
fn send_ymodem<D: Read + Write>(
    dev: &mut D,
    file: std::fs::File,
    path: &str,
    total: u64,
    on_progress: &impl Fn(&ModemProgress),
) -> Result<(), String> {
    let file_name = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "firmware.bin".into());
    let cb = |sent: u64, total: u64| {
        on_progress(&ModemProgress {
            kind: "progress",
            operation: "ymodem".into(),
            size: sent,
            total,
            message: None,
        });
    };
    let mut reader = ProgressReader {
        inner: file,
        sent: 0,
        total,
        cb: &cb,
    };
    let mut y = ymodem::ymodem::Ymodem::new();
    y.send(dev, &mut reader, file_name, total)
        .map_err(|e| format!("YMODEM 发送失败: {e:?}"))
}

// ── ZMODEM（zmodem2 调用方驱动状态机） ──
fn send_zmodem<D: Read + Write>(
    dev: &mut D,
    path: &str,
    total: u64,
    cancel: &AtomicBool,
    on_progress: &impl Fn(&ModemProgress),
) -> Result<(), String> {
    use std::io::Seek;
    use std::time::{Duration, Instant};
    use zmodem2::{Action, Event, FileInfo, Sender};

    let name = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "firmware.bin".into());
    let name_bytes = name.as_bytes();

    let mut s = Sender::new().map_err(|e| format!("ZMODEM 初始化失败: {e}"))?;
    s.start_file(FileInfo::new(
        name_bytes,
        Some(zmodem2::Position::from(total as u32)),
    ))
    .map_err(|e| format!("ZMODEM 启动文件失败: {e}"))?;

    let mut file = std::fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut buf = [0u8; 8192];
    let mut finished = false;
    let mut sent = 0u64;
    let start = Instant::now();
    let mut last_peer = Instant::now();
    // 上限保护：避免对端无响应时无限轮询（底层读 500ms 超时，单轮有界）
    for _ in 0..500_000 {
        // 用户强制停止：立即退出（比 10s/120s 超时更快响应）
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        // 无设备/对端不应答时快速失败，与 X/Y 的“Exhausted max retries”体验一致，
        // 避免把命令线程长期占满导致 UI 假死。
        if start.elapsed() > Duration::from_secs(120) {
            return Err("ZMODEM 超时（对端无响应？）".into());
        }
        if !finished && last_peer.elapsed() > Duration::from_secs(10) {
            return Err("ZMODEM 未收到对端响应（未连接设备？）".into());
        }
        match s.poll() {
            Action::WriteWire(bytes) => {
                // bytes 借自 s；复制到自有缓冲以解除借用，再通知状态机已写出
                let chunk = bytes.to_vec();
                dev.write_all(&chunk)
                    .map_err(|e| format!("ZMODEM 写串口失败: {e}"))?;
                s.wire_written(chunk.len());
            }
            Action::ReadFile { offset, max_len } => {
                if !finished {
                    file.seek(std::io::SeekFrom::Start(offset.get() as u64))
                        .map_err(|e| format!("ZMODEM 文件定位失败: {e}"))?;
                    let mut data = vec![0u8; max_len];
                    let n = file
                        .read(&mut data)
                        .map_err(|e| format!("ZMODEM 读文件失败: {e}"))?;
                    s.submit_file(&data[..n])
                        .map_err(|e| format!("ZMODEM 提交文件块失败: {e}"))?;
                    sent = sent.max(offset.get() as u64 + n as u64);
                }
            }
            Action::Event(ev) => match ev {
                Event::FileCompleted => {
                    finished = true;
                    s.finish()
                        .map_err(|e| format!("ZMODEM 结束文件失败: {e}"))?;
                }
                Event::SessionCompleted => {
                    on_progress(&ModemProgress {
                        kind: "progress",
                        operation: "zmodem".into(),
                        size: sent,
                        total: 0,
                        message: None,
                    });
                    return Ok(());
                }
                Event::Aborted => {
                    return Err("ZMODEM 被对端中止".into());
                }
                _ => {}
            },
            Action::Idle => {
                // 读串口（Duplex 把读超时转成 TimedOut）；无字节则让状态机推进超时重发
                match dev.read(&mut buf) {
                    Ok(n) => {
                        last_peer = Instant::now();
                        s.submit_wire(&buf[..n])
                            .map_err(|e| format!("ZMODEM 喂入串口数据失败: {e}"))?;
                    }
                    Err(ref e) if e.kind() == io::ErrorKind::TimedOut => {
                        let _ = s.timeout();
                    }
                    Err(e) => return Err(format!("ZMODEM 读串口失败: {e}")),
                }
            }
            _ => {}
        }
    }
    Err("ZMODEM 传输未在预期轮次内完成（对端无响应？）".into())
}

/// 独立串口场景下的 Read/Write 垫片（把 Box<dyn SerialPort> 包成 TransportRead/Write）。
struct SerialReadShim {
    port: Box<dyn serialport::SerialPort>,
}
impl crate::transport::TransportRead for SerialReadShim {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.port.read(buf)
    }
}
struct SerialWriteShim {
    port: Box<dyn serialport::SerialPort>,
}
impl crate::transport::TransportWrite for SerialWriteShim {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        self.port.write_all(data)
    }
}
