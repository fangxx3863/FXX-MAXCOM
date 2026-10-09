//! 会话编排：连接生命周期（含自动重连）+ 引擎线程组 + 对上层的批量回调。
//!
//! 线程模型（ADR-0015 各引擎独立解析）：
//! - 读线程：阻塞读传输 → 发布 raw 事件 + Bus 扇出；**掉线时按退避重连**（可关）
//! - 日志线程：Bus 消费 → 分行 → 解码 → 染色 → 过滤 → 批量 entry 回调（~30ms 合批）
//! - 绘图线程：Bus 消费 → 帧解析 → ChannelStore（前端轮询快照，零事件风暴）
//!
//! 上层通过 [`SessionEvents`] trait 接收回调；测试用内存记录器验证。

use crossbeam_channel::{bounded, select, tick, Sender};
use maxcom_core::ansistrip::strip_ansi;
use maxcom_core::bus::Bus;
use maxcom_core::colorize::{ColorRule, ColorizeEngine};
use maxcom_core::encoding::StreamDecoder;
use maxcom_core::filter::{FilterEngine, FilterRule};
use maxcom_core::framing::TimestampMode;
use maxcom_core::plot::parser::{make_parser, FrameParser};
use maxcom_core::plot::{ChannelMetrics, ChannelStore};
use maxcom_core::splitter::LineSplitter;
use maxcom_core::stats::{StatsSnapshot, StatsTracker};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 二进制捕获落盘：流式写入系统临时目录（分块 flush），避免 1GB 级数据驻留内存。
/// 捕获结束后由 save_capture 将临时文件复制到用户选择的目标路径并删除临时文件。
/// 临时文件在会话 Drop/cancel 时清理，不长期占用磁盘。
struct CaptureSink {
    path: PathBuf,
    file: std::fs::File,
    buf: Vec<u8>,
    total: u64,
}

/// 每累计 64KB flush 一次到临时文件（控制写盘粒度，兼顾吞吐与故障丢失面）
const CAP_CHUNK: usize = 64 * 1024;

/// 保证同一毫秒内多次创建临时文件也不同名（并发会话/测试）
static CAP_SEQ: AtomicU64 = AtomicU64::new(0);

impl CaptureSink {
    fn new() -> std::io::Result<Self> {
        let ms = unix_ms();
        let seq = CAP_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "maxcom_capture_{}_{}_{}.bin",
            std::process::id(),
            ms,
            seq
        ));
        let file = std::fs::File::create(&path)?;
        Ok(Self {
            path,
            file,
            buf: Vec::with_capacity(CAP_CHUNK),
            total: 0,
        })
    }

    fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.buf.extend_from_slice(data);
        self.total += data.len() as u64;
        if self.buf.len() >= CAP_CHUNK {
            self.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        self.file.write_all(&self.buf)?;
        self.buf.clear();
        Ok(())
    }

    /// 封口：flush 剩余字节并 fsync（save_capture 复制前调用）
    fn finish(&mut self) -> std::io::Result<()> {
        self.flush()?;
        self.file.sync_all()?;
        Ok(())
    }
}

/// 长流防护：无换行/无空闲的连续数据（二进制流）累计超过该字节数即强制封行输出。
/// 否则 splitter pending / time_buf 只涨不拆、batch 恒空，前端收不到任何 entries
/// （xterm 走 raw 通道不受影响）；且最终一次性刷出的会是超大单行，前端渲染卡死。
const PARTIAL_FLUSH_CAP: usize = 4096;

/// I/O 记录方向（MCP `read_io` 区分「设备发来的」与「我发出去的」）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoDir {
    /// 接收（链路 → 主机）
    Rx,
    /// 发送（主机 → 链路）
    Tx,
}

/// 会话最近 I/O 记录块（原始字节，未解码、未分行）。
///
/// 语义刻意贴着 ADR-0015「单一原始流」：这里存的就是读线程/写路径看到的原始字节，
/// 不做染色/过滤，保证 MCP 侧看到的是事实而非渲染结果。
#[derive(Debug, Clone)]
pub struct IoChunk {
    /// 序号：会话内单调递增。同一毫秒内多块也能精确定序，`io_since` 据此续读。
    pub seq: u64,
    /// 墙钟毫秒（不是单调钟：AI 侧需要能直接读懂"什么时候"）
    pub ts_ms: u64,
    pub dir: IoDir,
    pub data: Vec<u8>,
}

/// 单块上限：一次大读取切分为多块，避免单条记录吃掉整个环（也便于按序续读）。
const IO_CHUNK_MAX: usize = 32 * 1024;
/// 环形缓冲总容量（字节）：超出丢最旧。512 KiB 约合 2 分钟 @ 4 KB/s 的持续流量。
const IO_RING_CAP: usize = 512 * 1024;

/// 会话级 I/O 环形缓冲（固定上限，丢最旧）。
///
/// 为什么需要它：前端只有自己的行模型（`LogViewPage.rows`），后端此前**没有任何**
/// 可查询的历史视图 —— 而 MCP 需要「发一条命令、读回响应」这条最基本的闭环。
/// 这里只保留最近若干字节，长期运行不会无界增长。
#[derive(Default)]
struct IoRing {
    next_seq: u64,
    bytes: usize,
    chunks: VecDeque<IoChunk>,
}

impl IoRing {
    fn push(&mut self, dir: IoDir, data: &[u8], ts_ms: u64) {
        for part in data.chunks(IO_CHUNK_MAX) {
            self.next_seq += 1;
            self.bytes += part.len();
            self.chunks.push_back(IoChunk {
                seq: self.next_seq,
                ts_ms,
                dir,
                data: part.to_vec(),
            });
        }
        // 至少保留一块：容量远大于单块上限，正常不会退化为空环
        while self.bytes > IO_RING_CAP && self.chunks.len() > 1 {
            if let Some(old) = self.chunks.pop_front() {
                self.bytes -= old.data.len();
            }
        }
    }

    /// 取 `seq > after_seq` 的块，累计字节数不超过 `max_bytes`（首块超限也照样返回，保证能推进）。
    fn since(&self, after_seq: u64, max_bytes: usize) -> Vec<IoChunk> {
        let mut out = Vec::new();
        let mut total = 0usize;
        for c in &self.chunks {
            if c.seq <= after_seq {
                continue;
            }
            if !out.is_empty() && total + c.data.len() > max_bytes {
                break;
            }
            total += c.data.len();
            out.push(c.clone());
        }
        out
    }

    fn max_seq(&self) -> u64 {
        self.next_seq
    }

    /// 环内最旧块序号（环为空返回 `next_seq`）。调用方据此识别「中间数据已被覆盖」的断档。
    fn oldest_seq(&self) -> u64 {
        self.chunks.front().map(|c| c.seq).unwrap_or(self.next_seq)
    }

    fn clear(&mut self) {
        self.chunks.clear();
        self.bytes = 0;
    }
}

/// 日志条目 DTO（segments 已染色；前端直接渲染）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntryDto {
    pub ts_ms: u64,
    pub text: String,
    pub segments: Vec<maxcom_core::colorize::ColoredSegment>,
    /// 原始行字节的 hex（HEX 显示模式用）
    pub raw_hex: String,
    /// 是否未换行结束的部分行（line 分包空闲封行刷出的中间态，前端应续接到当前行而非断行）
    #[serde(default)]
    pub partial: bool,
}

/// 绘图快照 DTO（前端 ~50ms 轮询一次）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlotSnapshotDto {
    pub channel_count: usize,
    pub total_points: usize,
    pub series: Vec<Vec<f64>>,
    pub metrics: Vec<Option<ChannelMetrics>>,
    /// ASCII 表头智能识别的通道名（无表头为空，前端回退 CHn）
    #[serde(default)]
    pub channel_names: Vec<String>,
}

/// 连接阶段：驱动前端「连接按钮 / 指示灯」状态机的唯一依据。
///
/// 为什么不能只看 `connected`：连接建立（串口 open、SSH 握手，最长 20s）与掉线重连
/// 都是**过程**而非瞬时状态，前端必须能区分「正在连」与「连不上」，才能把按钮切成
/// 「取消 + 转圈」让用户随时放弃（ADR-0020）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConnPhase {
    /// 未连接（空闲）
    #[default]
    Disconnected,
    /// 正在建立连接（按钮 = 取消 + 转圈）
    Connecting,
    /// 掉线后自动重连中（按钮 = 取消 + 转圈，`attempt` = 已尝试次数）
    Reconnecting,
    /// 链路可用
    Connected,
    /// 连接/会话异常结束且不会自动恢复（原因见 `error`）
    Failed,
    /// 用户主动取消连接尝试
    Cancelled,
}

/// 连接状态事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnState {
    /// 链路是否可用（自动重连退避期间为 false —— 此时会话仍在，但收不到数据）
    pub connected: bool,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub error: Option<String>,
    /// 连接阶段（旧前端缺省视为 `disconnected`，向后兼容）
    #[serde(default)]
    pub phase: ConnPhase,
    /// 自动重连已尝试次数（`phase == reconnecting` 时有意义）
    #[serde(default)]
    pub attempt: u32,
    /// 实际链路类型（`ConnConfig::kind()` 的取值）。**只在这条链路确实建立/重连中时给出**。
    ///
    /// 用途：前端据此回填顶栏「连接类型」下拉 —— 连接可能由 MCP/AI 侧发起，
    /// 此时下拉还停在用户上次的选择上，显示会与真实链路不符。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

impl ConnState {
    /// 链路可用
    fn up(label: String) -> Self {
        Self {
            connected: true,
            label,
            error: None,
            phase: ConnPhase::Connected,
            attempt: 0,
            kind: None,
        }
    }

    /// 会话结束且不再重连（有 error 归为 failed，否则为普通断开）
    fn down(label: String, error: Option<String>) -> Self {
        Self {
            connected: false,
            phase: if error.is_some() {
                ConnPhase::Failed
            } else {
                ConnPhase::Disconnected
            },
            label,
            error,
            attempt: 0,
            kind: None,
        }
    }

    /// 正在建立连接
    fn connecting() -> Self {
        Self {
            connected: false,
            label: String::new(),
            error: None,
            phase: ConnPhase::Connecting,
            attempt: 0,
            kind: None,
        }
    }

    /// 掉线后自动重连中（带原因与已尝试次数）
    fn reconnecting(label: String, error: Option<String>, attempt: u32) -> Self {
        Self {
            connected: false,
            label,
            error,
            phase: ConnPhase::Reconnecting,
            attempt,
            kind: None,
        }
    }

    /// 用户取消连接尝试
    fn cancelled() -> Self {
        Self {
            connected: false,
            label: String::new(),
            error: None,
            phase: ConnPhase::Cancelled,
            attempt: 0,
            kind: None,
        }
    }

    /// 标注这条状态所属的**实际链路类型**（`ConnConfig::kind()`）。
    ///
    /// 只在链路建立 / 重连中调用 —— 前端据此把顶栏「连接类型」下拉回填成真实类型
    /// （连接可能是 MCP/AI 侧发起的，下拉里未必是它）。断开态不标，
    /// 让用户自己的选择保留在界面上，便于原样重连。
    fn with_kind(mut self, kind: &'static str) -> Self {
        self.kind = Some(kind.to_string());
        self
    }
}

/// 上层事件出口（src-tauri 实现 = tauri emit；测试实现 = 内存记录）
pub trait SessionEvents: Send + Sync {
    fn raw(&self, data: &[u8]);
    fn entries(&self, entries: &[LogEntryDto]);
    fn state(&self, state: &ConnState);
}

/// 日志路径选项
#[derive(Debug, Clone)]
pub struct LogOptions {
    pub idle_timeout_ms: u64,
    pub timestamp_mode: TimestampMode,
    pub encoding: String,
    /// 分包方式："timeout"=空闲超时封行（默认）；"line"=仅按换行符分包，不做空闲封行
    pub split_mode: String,
}

impl Default for LogOptions {
    fn default() -> Self {
        Self {
            idle_timeout_ms: 10,
            timestamp_mode: TimestampMode::Absolute,
            encoding: "auto".into(),
            split_mode: "line".into(),
        }
    }
}

/// 发送负载：文本或 hex 二选一（对齐发送面板）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendPayload {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub hex: Option<String>,
    /// 追加换行："none" | "\n" | "\r" | "\r\n"
    #[serde(default)]
    pub newline: String,
    /// 本次发送是否参与本地回显（设备不回显时也能在收发区看到自己发了什么）。
    /// 默认 false：终端击键、发文件分块、Modbus 组帧等都不该被当成接收内容刷进日志。
    #[serde(default)]
    pub echo: bool,
}

enum Cmd {
    SetLogOptions(LogOptions),
    SetFilters(Vec<FilterRule>),
    SetColorRules {
        master: bool,
        ansi_yield: bool,
        rules: Vec<ColorRule>,
    },
    ClearLog,
}

/// 会话运行时状态：读线程写入、命令/查询侧读取（Arc 共享，避免为查询加锁）。
///
/// `alive` 让上层能识别「会话已终结但 `active` 尚未回收」的残留：此时必须按未连接
/// 上报（否则前端会拿到 `connected: true`，进而出现「点连接先断开再连、连不上弹报错」）。
#[derive(Default)]
struct SessionStatus {
    /// 读线程是否仍在运行（false = 会话已终结，`active` 可安全回收）
    alive: AtomicBool,
    /// 链路是否可用（自动重连退避期间为 false）
    link: AtomicBool,
    /// 是否正在自动重连
    reconnecting: AtomicBool,
    /// 自动重连已尝试次数（重连成功后归零）
    attempt: AtomicU32,
    /// 最近一次错误（掉线原因 / 重连失败原因）
    last_error: Mutex<Option<String>>,
}

impl SessionStatus {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            // 会话刚装好 = 读线程在跑、链路可用（`link` 默认 false 会让
            // conn_state() 在连接成功的瞬间误报「未连接」→ 前端再点连接被判重复连接）
            alive: AtomicBool::new(true),
            link: AtomicBool::new(true),
            ..Default::default()
        })
    }

    fn set_error(&self, e: impl Into<String>) {
        *self.last_error.lock().unwrap() = Some(e.into());
    }

    fn error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }
}

/// 连接尝试（前端点击「连接」后、连接真正建立前）
struct ConnAttempt {
    /// 连接代次：取消/新尝试都会使旧代次作废，迟到的 open 结果据此丢弃
    gen: u64,
    /// 取消位：置位后本次尝试的结果（无论成功失败）一律丢弃
    cancel: Arc<AtomicBool>,
}

/// 一个活动会话的全部资源
struct Active {
    stop: Arc<AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
    /// 共享写句柄：自动重连成功后由读线程换新
    write: Arc<Mutex<Box<dyn super::transport::TransportWrite>>>,
    stats: Arc<StatsTracker>,
    cmd_tx: Sender<Cmd>,
    label: String,
    /// 实际链路类型（`ConnConfig::kind()`）；`conn_state` 据此回填前端的连接类型下拉
    kind: &'static str,
    dtr: Arc<AtomicBool>,
    rts: Arc<AtomicBool>,
    /// 原始流总线：本地回显按 "log" 定向投递（不进绘图订阅者）
    bus: Arc<Bus>,
    /// 运行时状态（连接阶段 / 最近错误），供 conn_state 与读线程共享
    status: Arc<SessionStatus>,
}

/// 会话管理器：同一时刻至多一个活动连接（ADR-0016 单连接，多实例满足多端口）。
pub struct SessionManager {
    active: Mutex<Option<Active>>,
    events: Arc<dyn SessionEvents>,
    plot: Arc<Mutex<ChannelStore>>,
    /// 共享句柄而非连接时快照：连接后 set_plot_format 的修改对绘图线程立即可见
    /// （此前 connect 克隆快照、热切换写原字段，线程永远读旧值 → 连接中改格式不生效）
    plot_format: Arc<Mutex<Option<maxcom_core::plot::format::DataFormat>>>,
    /// 格式版本号：变更 +1，绘图线程据此热重建 parser（修复连接中改格式不生效）
    plot_fmt_ver: Arc<AtomicU64>,
    /// ASCII 表头识别的通道名（绘图线程写入，快照读取）
    plot_names: Arc<Mutex<Vec<String>>>,
    /// 掉线自动重连开关
    auto_reconnect: Arc<AtomicBool>,
    /// 重连间隔（ms，测试可调小）
    reconnect_delay_ms: AtomicU64,
    /// 二进制接收捕获（Some=捕获中，流式写临时文件）
    capture: Arc<Mutex<Option<CaptureSink>>>,
    capture_dropped: Arc<AtomicU64>,
    /// 持久化配置：连接后重放给新线程引擎（修复冷启动时因未连接被丢弃的规则）
    filters: Mutex<Vec<FilterRule>>,
    colors: Mutex<(bool, bool, Vec<ColorRule>)>,
    log_options: Mutex<LogOptions>,
    /// 最近一次 connect 的配置快照：供 modem_transfer 在独占传输后重连恢复会话。
    last_config: Mutex<Option<super::transport::ConnConfig>>,
    /// modem 传输取消位（前端强制停止按钮置位；每次传输开始时复位）
    modem_cancel: Arc<AtomicBool>,
    /// 非阻塞连接尝试（Some = 正在连接）：取消位 + 代次
    connecting: Mutex<Option<ConnAttempt>>,
    /// 连接代次：取消或新尝试 +1，用于作废迟到的 open 结果
    conn_gen: AtomicU64,
    /// 最近 I/O 环形缓冲（跨重连保留；MCP `read_io` / 诊断读取）
    io_ring: Arc<Mutex<IoRing>>,
}

/// 加锁顺序约定（避免死锁）：`active` → `connecting` → `SessionStatus::last_error`。
/// 任何路径都不得反向获取。
impl SessionManager {
    pub fn new(events: Arc<dyn SessionEvents>) -> Self {
        Self {
            active: Mutex::new(None),
            events,
            plot: Arc::new(Mutex::new(ChannelStore::new(1, 10000))),
            plot_format: Arc::new(Mutex::new(None)),
            plot_fmt_ver: Arc::new(AtomicU64::new(0)),
            plot_names: Arc::new(Mutex::new(Vec::new())),
            auto_reconnect: Arc::new(AtomicBool::new(true)),
            reconnect_delay_ms: AtomicU64::new(2000),
            capture: Arc::new(Mutex::new(None)),
            capture_dropped: Arc::new(AtomicU64::new(0)),
            filters: Mutex::new(Vec::new()),
            colors: Mutex::new((true, true, Vec::new())),
            log_options: Mutex::new(LogOptions::default()),
            last_config: Mutex::new(None),
            modem_cancel: Arc::new(AtomicBool::new(false)),
            connecting: Mutex::new(None),
            conn_gen: AtomicU64::new(0),
            io_ring: Arc::new(Mutex::new(IoRing::default())),
        }
    }

    /// 会话是否仍在运行（读线程未退出）。已终结但未回收的残留会返回 false。
    pub fn is_connected(&self) -> bool {
        let mut guard = self.active.lock().unwrap();
        self.reap_dead(&mut guard);
        guard
            .as_ref()
            .is_some_and(|a| a.status.alive.load(Ordering::Relaxed))
    }

    /// 回收已终结的会话（读线程已退出、`active` 尚未清理）。
    /// 线程均已退出 → 直接 drop 释放传输句柄（不 join，避免与自身/已退出线程相争）。
    fn reap_dead(&self, guard: &mut Option<Active>) {
        let dead = matches!(&*guard, Some(a) if !a.status.alive.load(Ordering::Relaxed));
        if dead {
            if let Some(a) = guard.take() {
                a.stop.store(true, Ordering::Relaxed); // 兜底：让日志/绘图线程尽快退出
                drop(a);
            }
        }
    }

    /// 查询当前连接状态（主动查询，区别于被动 state 事件）。
    /// 按 [`ConnPhase`] 上报，前端据此渲染按钮/指示灯（连接中可取消、重连中可中止）。
    pub fn conn_state(&self) -> ConnState {
        let mut guard = self.active.lock().unwrap();
        self.reap_dead(&mut guard);
        if let Some(a) = &*guard {
            let st = &a.status;
            if st.link.load(Ordering::Relaxed) {
                return ConnState::up(a.label.clone()).with_kind(a.kind);
            }
            if st.reconnecting.load(Ordering::Relaxed) {
                return ConnState::reconnecting(
                    a.label.clone(),
                    st.error(),
                    st.attempt.load(Ordering::Relaxed),
                )
                .with_kind(a.kind);
            }
            return ConnState::down(a.label.clone(), st.error());
        }
        if self.connecting.lock().unwrap().is_some() {
            return ConnState::connecting();
        }
        ConnState::down(String::new(), None)
    }

    pub fn set_auto_reconnect(&self, on: bool) {
        self.auto_reconnect.store(on, Ordering::Relaxed);
    }

    pub fn set_reconnect_delay_ms(&self, ms: u64) {
        self.reconnect_delay_ms.store(ms.max(10), Ordering::Relaxed);
    }

    /// DTR/RTS：转发给当前传输；重连成功后自动重放
    pub fn set_dtr(&self, on: bool) -> Result<(), String> {
        let guard = self.active.lock().unwrap();
        let Some(a) = &*guard else {
            return Err("未连接".into());
        };
        a.dtr.store(on, Ordering::Relaxed);
        let res = a.write.lock().unwrap().set_dtr(on);
        res.map_err(|e| e.to_string())
    }

    pub fn set_rts(&self, on: bool) -> Result<(), String> {
        let guard = self.active.lock().unwrap();
        let Some(a) = &*guard else {
            return Err("未连接".into());
        };
        a.rts.store(on, Ordering::Relaxed);
        let res = a.write.lock().unwrap().set_rts(on);
        res.map_err(|e| e.to_string())
    }

    /// 开始捕获接收数据为二进制（清空并新建临时文件从头计）
    pub fn start_capture(&self) {
        self.capture_dropped.store(0, Ordering::Relaxed);
        match CaptureSink::new() {
            Ok(sink) => *self.capture.lock().unwrap() = Some(sink),
            Err(e) => {
                eprintln!("创建捕获临时文件失败: {e}");
                *self.capture.lock().unwrap() = None;
            }
        }
    }

    pub fn stop_capture(&self) {
        self.cancel_capture();
    }

    /// 停止捕获并把临时文件复制到目标路径，返回字节数。
    pub fn save_capture(&self, path: &str) -> Result<u64, String> {
        let sink = self.capture.lock().unwrap().take();
        let Some(mut sink) = sink else {
            return Err("未在捕获中".into());
        };
        sink.finish().map_err(|e| format!("落盘失败: {e}"))?;
        let n = sink.total;
        std::fs::copy(&sink.path, path).map_err(|e| format!("写入失败: {e}"))?;
        let _ = std::fs::remove_file(&sink.path);
        Ok(n)
    }

    /// 取消捕获：丢弃临时文件，不保存。
    pub fn cancel_capture(&self) {
        let sink = self.capture.lock().unwrap().take();
        if let Some(s) = sink {
            let _ = std::fs::remove_file(&s.path);
        }
    }

    /// 捕获状态：(是否捕获中, 已捕获字节, 因超限丢弃的字节)
    pub fn capture_state(&self) -> (bool, u64, u64) {
        let g = self.capture.lock().unwrap();
        (
            g.is_some(),
            g.as_ref().map(|s| s.total).unwrap_or(0),
            self.capture_dropped.load(Ordering::Relaxed),
        )
    }

    /// 设置绘图数据格式（切换时清空缓冲；绘图线程经版本号感知并热重建 parser）
    pub fn set_plot_format(&self, fmt: maxcom_core::plot::format::DataFormat) {
        let ch = fmt.channel_count() as usize; // 先读再 move（DataFormat 非 Copy）
        *self.plot_format.lock().unwrap() = Some(fmt);
        self.plot_fmt_ver.fetch_add(1, Ordering::Relaxed);
        self.plot_names.lock().unwrap().clear();
        // ASCII 自动（channel_count == 0）先按 1 通道占位，首帧到达后按实际列数重建
        *self.plot.lock().unwrap() = ChannelStore::new(ch.max(1), 10000);
    }

    /// 设置绘图缓冲区容量（X 轴时间窗；改动会清空已缓冲数据）
    pub fn set_plot_buffer(&self, capacity: usize) {
        let cap = capacity.clamp(100, 1_000_000);
        let fmt = self.plot_format.lock().unwrap().clone();
        let ch = fmt
            .as_ref()
            .map(|f| f.channel_count() as usize)
            .unwrap_or(1);
        *self.plot.lock().unwrap() = ChannelStore::new(ch.max(1), cap);
    }

    /// 绘图快照（前端轮询）
    pub fn plot_snapshot(&self, max_points: usize) -> PlotSnapshotDto {
        let store = self.plot.lock().unwrap();
        let mut dto = PlotSnapshotDto {
            channel_count: store.channel_count(),
            total_points: store.len(),
            channel_names: self.plot_names.lock().unwrap().clone(),
            ..Default::default()
        };
        for ch in 0..store.channel_count() {
            dto.series.push(store.downsampled(ch, max_points));
            dto.metrics.push(store.metrics(ch));
        }
        dto
    }

    pub fn stats(&self) -> StatsSnapshot {
        match &*self.active.lock().unwrap() {
            Some(a) => a.stats.snapshot(),
            None => StatsSnapshot::default(),
        }
    }

    /// 读取最近 I/O：返回 `seq > after_seq` 的块（累计不超过 `max_bytes`），
    /// 以及 `(当前最大 seq, 环内最旧 seq)`。
    ///
    /// 用法（MCP `read_io`）：首次调用传 `after_seq = 0` 取全量近况，
    /// 之后用上次返回的最大 seq 续读；若 `最旧 seq > after_seq + 1` 说明中间数据
    /// 已被环形缓冲覆盖（客户端应知道自己漏了一截）。
    pub fn io_since(&self, after_seq: u64, max_bytes: usize) -> (Vec<IoChunk>, u64, u64) {
        let ring = self.io_ring.lock().unwrap();
        (
            ring.since(after_seq, max_bytes),
            ring.max_seq(),
            ring.oldest_seq(),
        )
    }

    /// 清空最近 I/O 环形缓冲（MCP `clear_log` 用：与前端显示区的清空各管各的，
    /// 因此不与 `Cmd::ClearLog` 合并 —— 前端清屏不应抹掉 AI 正在读的历史）。
    pub fn clear_io(&self) {
        self.io_ring.lock().unwrap().clear();
    }

    /// 打开连接并启动引擎线程组（**阻塞**：串口 open / SSH 握手会在本线程内完成）。
    ///
    /// 仅供测试与引擎内部（modem 传输后恢复连接）使用；UI 入口必须走
    /// [`SessionManager::begin_connect`]——它会阻塞当前线程（最坏 20s），
    /// 而 Tauri 同步命令跑在主线程上，会直接卡死整个界面。
    pub fn connect(&self, config: super::transport::ConnConfig) -> Result<(), String> {
        config.validate()?;
        let mut guard = self.active.lock().unwrap();
        self.reap_dead(&mut guard);
        if guard.is_some() {
            return Err("已有活动连接（单连接设计，先断开再连）".into());
        }
        let pair = super::transport::open(&config).map_err(|e| e.to_string())?;
        self.install(&mut guard, config, pair)
    }

    /// 开始一次**非阻塞**连接：立即返回（仅参数错误同步返回），过程与结果通过
    /// state 事件广播 `connecting → connected | failed`。
    ///
    /// 前端点「连接」后可立刻把按钮切成「取消 + 转圈」；点取消调
    /// [`SessionManager::cancel_connect`]，本次尝试的结果（含迟到成功）一律丢弃。
    pub fn begin_connect(
        self: &Arc<Self>,
        config: super::transport::ConnConfig,
    ) -> Result<(), String> {
        config.validate()?;
        let cancel = Arc::new(AtomicBool::new(false));
        let gen = {
            let mut guard = self.active.lock().unwrap();
            self.reap_dead(&mut guard);
            if guard.is_some() {
                return Err("已有活动连接（单连接设计，先断开再连）".into());
            }
            let gen = self.conn_gen.fetch_add(1, Ordering::Relaxed) + 1;
            let mut cg = self.connecting.lock().unwrap();
            if let Some(old) = cg.replace(ConnAttempt {
                gen,
                cancel: cancel.clone(),
            }) {
                old.cancel.store(true, Ordering::Relaxed); // 旧尝试作废（迟到的结果被丢弃）
            }
            gen
        };
        self.events.state(&ConnState::connecting());
        let me = Arc::clone(self);
        let cfg = config.clone();
        std::thread::Builder::new()
            .name("connect".into())
            .spawn(move || {
                let res = super::transport::open(&cfg).map_err(|e| e.to_string());
                me.finish_connect(gen, &cancel, cfg, res);
            })
            .map_err(|e| {
                // 线程创建失败：清掉尝试登记，否则前端会永远停在「连接中」
                self.clear_attempt(gen);
                self.events
                    .state(&ConnState::down(String::new(), Some(e.to_string())));
                e.to_string()
            })?;
        Ok(())
    }

    /// 取消进行中的连接尝试（前端「取消」按钮）。返回是否确有尝试被取消。
    ///
    /// 立即返回：底层 open 仍在后台线程跑完，但其结果会被丢弃（句柄随之 Drop 释放），
    /// 用户不必等待握手超时。
    pub fn cancel_connect(&self) -> bool {
        let taken = self.connecting.lock().unwrap().take();
        match taken {
            Some(c) => {
                c.cancel.store(true, Ordering::Relaxed);
                self.conn_gen.fetch_add(1, Ordering::Relaxed); // 作废该代次
                self.events.state(&ConnState::cancelled());
                true
            }
            None => false,
        }
    }

    /// 清理指定代次的连接尝试登记（不影响已被取代的新尝试）
    fn clear_attempt(&self, gen: u64) {
        let mut cg = self.connecting.lock().unwrap();
        if cg.as_ref().is_some_and(|c| c.gen == gen) {
            *cg = None;
        }
    }

    /// 连接线程回调：安装会话或广播失败。
    /// 取消 / 已被新尝试取代 → 只释放句柄，不改任何状态（前端已按取消处理）。
    fn finish_connect(
        self: &Arc<Self>,
        gen: u64,
        cancel: &AtomicBool,
        cfg: super::transport::ConnConfig,
        res: Result<super::transport::ConnPair, String>,
    ) {
        if cancel.load(Ordering::Relaxed) || self.conn_gen.load(Ordering::Relaxed) != gen {
            drop(res);
            return;
        }
        match res {
            Ok(pair) => {
                let mut guard = self.active.lock().unwrap();
                self.reap_dead(&mut guard);
                if guard.is_some() {
                    // 竞态：已有别的连接（理论上被 active 互斥挡住，兜底防双开设备）
                    drop(pair);
                    self.clear_attempt(gen);
                    self.events.state(&ConnState::down(
                        String::new(),
                        Some("已有活动连接（单连接设计，先断开再连）".into()),
                    ));
                    return;
                }
                match self.install(&mut guard, cfg, pair) {
                    Ok(()) => self.clear_attempt(gen),
                    Err(e) => {
                        self.clear_attempt(gen);
                        self.events.state(&ConnState::down(String::new(), Some(e)));
                    }
                }
            }
            Err(e) => {
                self.clear_attempt(gen);
                self.events.state(&ConnState::down(String::new(), Some(e)));
            }
        }
    }

    /// 把已打开的连接装成活动会话（建线程组 + 置 active + 广播 connected）。
    /// `guard` 由调用方持有（单连接互斥），本函数不改其外部锁顺序。
    fn install(
        &self,
        guard: &mut Option<Active>,
        config: super::transport::ConnConfig,
        pair: super::transport::ConnPair,
    ) -> Result<(), String> {
        let label = pair.label.clone();
        let kind = config.kind();
        *self.last_config.lock().unwrap() = Some(config.clone());

        let stop = Arc::new(AtomicBool::new(false));
        let bus = Arc::new(Bus::new());
        let stats = Arc::new(StatsTracker::new());
        let (cmd_tx, cmd_rx) = bounded::<Cmd>(64);
        let write = Arc::new(Mutex::new(pair.write));
        let dtr = Arc::new(AtomicBool::new(false));
        let rts = Arc::new(AtomicBool::new(false));
        let status = SessionStatus::new();
        let mut threads = Vec::new();

        // ── 读线程（含自动重连） ──
        let mut read_half = pair.read;
        let ev = self.events.clone();
        let stop_r = stop.clone();
        let bus_r = bus.clone();
        let stats_r = stats.clone();
        let write_r = write.clone();
        let dtr_r = dtr.clone();
        let rts_r = rts.clone();
        let auto_r = self.auto_reconnect.clone();
        let delay_ms = self.reconnect_delay_ms.load(Ordering::Relaxed);
        let capture_r = self.capture.clone();
        let io_r = self.io_ring.clone();
        let label_r = label.clone();
        let cfg_r = config.clone();
        let status_r = status.clone();
        threads.push(
            std::thread::Builder::new()
                .name("reader".into())
                .spawn(move || {
                    let mut buf = [0u8; 4096];
                    'session: loop {
                        // ── 读循环 ──
                        loop {
                            if stop_r.load(Ordering::Relaxed) {
                                break 'session;
                            }
                            match read_half.read(&mut buf) {
                                Ok(0) => continue, // 超时节拍
                                Ok(n) => {
                                    stats_r.record_rx(n);
                                    // 最近 I/O 快照（MCP read_io）：与 raw 回调同点记录，
                                    // 保证 AI 看到的就是链路实际收到的字节序
                                    io_r.lock().unwrap().push(IoDir::Rx, &buf[..n], unix_ms());
                                    ev.raw(&buf[..n]);
                                    bus_r.publish(&buf[..n]);
                                    // 捕获（流式写临时文件；落盘失败则放弃本次捕获，不阻塞读循环）
                                    let write_err = {
                                        let mut g = capture_r.lock().unwrap();
                                        match g.as_mut() {
                                            Some(sink) => sink.write(&buf[..n]).is_err(),
                                            None => false,
                                        }
                                    };
                                    if write_err {
                                        *capture_r.lock().unwrap() = None;
                                    }
                                }
                                Err(e) => {
                                    // 掉线：记录原因并标记链路不可用。自动重连开启时
                                    // 由下面的重连循环负责广播状态（含尝试次数），
                                    // 避免同一件事连发两条事件。
                                    status_r.link.store(false, Ordering::Relaxed);
                                    status_r.set_error(e.to_string());
                                    if !auto_r.load(Ordering::Relaxed) {
                                        // 掉线且关闭自动重连：结束会话（不再重试）
                                        stop_r.store(true, Ordering::Relaxed);
                                        ev.state(&ConnState::down(
                                            label_r.clone(),
                                            status_r.error(),
                                        ));
                                        break 'session;
                                    }
                                    break;
                                }
                            }
                        }
                        // ── 掉线：自动重连循环 ──
                        // 先释放旧连接句柄：RttState/串口句柄等被读/写两侧共享持有，
                        // 不 drop 会让重连的 open() 因「设备被占用」一直失败
                        // （RTT 场景：拔 SWD 线后调试器 USB 仍在，旧 probe-rs Session
                        // 仍独占探针 USB 句柄 → 插回 SWD 也重连不上；手点连接成功是因为
                        // disconnect() 已 join 线程、句柄全部 drop）。
                        {
                            drop(read_half);
                            let mut w = write_r.lock().unwrap();
                            *w = Box::new(super::transport::DeadWrite);
                        }
                        loop {
                            if stop_r.load(Ordering::Relaxed) {
                                // 外部（disconnect/关标签）终止：状态事件由调用方广播
                                break 'session;
                            }
                            if !auto_r.load(Ordering::Relaxed) {
                                // 掉线且关闭自动重连：结束整个会话（日志/绘图线程随之退出）。
                                // 会话终结后 active 由 reap_dead() 回收；用户重新插回设备
                                // 需要手动点「连接」（不再有后台残留连接与误报）。
                                stop_r.store(true, Ordering::Relaxed);
                                ev.state(&ConnState::down(label_r.clone(), status_r.error()));
                                break 'session;
                            }
                            // 第 n 次尝试：先广播状态（前端据此显示「自动重连中（第 n 次）」+ 可取消），
                            // 再按退避等待——退避上限 15s，避免设备缺失时高频重试。
                            let attempt = status_r.attempt.fetch_add(1, Ordering::Relaxed) + 1;
                            status_r.reconnecting.store(true, Ordering::Relaxed);
                            ev.state(
                                &ConnState::reconnecting(
                                    label_r.clone(),
                                    status_r.error(),
                                    attempt,
                                )
                                .with_kind(cfg_r.kind()),
                            );
                            // 分片睡眠，保证 stop / 关闭自动重连都能及时生效
                            let step = 100u64;
                            let wait = reconnect_backoff_ms(delay_ms, attempt);
                            let mut waited = 0u64;
                            while waited < wait {
                                if stop_r.load(Ordering::Relaxed) {
                                    break 'session;
                                }
                                if !auto_r.load(Ordering::Relaxed) {
                                    break;
                                }
                                std::thread::sleep(Duration::from_millis(step.min(wait - waited)));
                                waited += step;
                            }
                            if stop_r.load(Ordering::Relaxed) {
                                break 'session;
                            }
                            if !auto_r.load(Ordering::Relaxed) {
                                continue; // 回到循环顶部 → 走「关闭重连 → 结束会话」
                            }
                            match super::transport::open(&cfg_r) {
                                Ok(pair) => {
                                    *write_r.lock().unwrap() = pair.write;
                                    // 重放 DTR/RTS
                                    {
                                        let mut w = write_r.lock().unwrap();
                                        let _ = w.set_dtr(dtr_r.load(Ordering::Relaxed));
                                        let _ = w.set_rts(rts_r.load(Ordering::Relaxed));
                                    }
                                    read_half = pair.read;
                                    status_r.attempt.store(0, Ordering::Relaxed);
                                    status_r.reconnecting.store(false, Ordering::Relaxed);
                                    status_r.link.store(true, Ordering::Relaxed);
                                    status_r.set_error(String::new());
                                    ev.state(
                                        &ConnState::up(label_r.clone()).with_kind(cfg_r.kind()),
                                    );
                                    continue 'session;
                                }
                                Err(e) => {
                                    // 失败原因留到下轮广播（attempt 递增）
                                    status_r.link.store(false, Ordering::Relaxed);
                                    status_r.set_error(e.to_string());
                                }
                            }
                        }
                    }
                    // 读线程退出 = 会话终结（threads 里的日志/绘图线程已收到 stop 或随后退出）
                    status_r.alive.store(false, Ordering::Relaxed);
                    status_r.reconnecting.store(false, Ordering::Relaxed);
                    status_r.link.store(false, Ordering::Relaxed);
                })
                .map_err(|e| e.to_string())?,
        );

        // ── 日志线程 ──
        let log_q = bus.subscribe("log");
        let ev = self.events.clone();
        let stop_l = stop.clone();
        let cmd_rx_log = cmd_rx.clone();
        // 冷启动配置：连接前 set_filters/set_color_rules/set_log_options 可能已被调用，
        // 此处同步播种到日志线程，避免异步 cmd 与数据竞速导致前几行漏过滤
        let init_filters = self.filters.lock().unwrap().clone();
        let (init_master, init_ansi_yield, init_rules) = self.colors.lock().unwrap().clone();
        let init_lopts = self.log_options.lock().unwrap().clone();
        threads.push(std::thread::Builder::new().name("logview".into()).spawn(move || {
            let mut decoder = StreamDecoder::new(&init_lopts.encoding);
            let mut splitter = LineSplitter::new();
            splitter.split_on_bare_cr = false; // line mode: split only on LF or CRLF; bare CR is line data
            let mut colorize = ColorizeEngine::new(true);
            colorize.master_enabled = init_master;
            colorize.ansi_yield = init_ansi_yield;
            colorize.reset();
            for r in init_rules {
                colorize.register(r);
            }
            let mut filter = FilterEngine::new();
            for r in &init_filters {
                filter.add_rule(r);
            }
            let mut options = init_lopts;
            let heartbeat = tick(Duration::from_millis(50));
            let mut batch: Vec<LogEntryDto> = Vec::new();
            let mut last_flush = std::time::Instant::now();
            let mut last_data_ms = now_mono_ms();
            let mut time_buf: Vec<u8> = Vec::new(); // 超时分包：不按换行拆，整段累积，空闲封行输出为一个时间块
            loop {
                select! {
                    recv(cmd_rx_log) -> msg => {
                        match msg {
                            Ok(Cmd::SetLogOptions(o)) => {
                                if o.encoding != options.encoding {
                                    decoder.set_encoding(&o.encoding);
                                }
                                options = o;
                            }
                            Ok(Cmd::SetFilters(rules)) => {
                                filter.reset();
                                for r in &rules { filter.add_rule(r); }
                            }
                            Ok(Cmd::SetColorRules { master, ansi_yield, rules }) => {
                                colorize.master_enabled = master;
                                colorize.ansi_yield = ansi_yield;
                                colorize.reset();
                                for r in rules { colorize.register(r); }
                            }
                            Ok(Cmd::ClearLog) => { splitter.clear(); time_buf.clear(); decoder.reset(); }
                            Err(_) => break,
                        }
                    }
                    recv(log_q) -> data => {
                        if let Ok(data) = data {
                            let now = now_mono_ms();
                            last_data_ms = now;
                            if options.split_mode == "line" {
                        for raw in splitter.feed(&data) {
                            let raw_text = decoder.decode(&raw);
                            let segments = colorize.process_line(&raw_text); // 见 ANSI → 产出颜色段
                            let text = strip_ansi(&raw_text); // DTO.text/过滤/raw 用干净文本
                            if filter.should_show(&text) {
                                batch.push(LogEntryDto { ts_ms: now, text, segments, raw_hex: hex_of(&raw), partial: false });
                            }
                        }
                        // 长流防护：连续流无换行（二进制流）时空闲封行永不触发（last_data_ms 持续刷新）、
                        // pending 只涨不拆 → batch 恒空 → 前端收发区冻结。pending 超过
                        // PARTIAL_FLUSH_CAP 即强制以新行输出（partial=false），保证前端持续收到数据。
                        // 只取前 CAP 字节、余量回填 pending：触发式整段取走会因读块(≤4096)叠加
                        // 产生近 8KB 的 entry，硬约束单条 ≤ CAP 更稳。
                        if splitter.pending_bytes() >= PARTIAL_FLUSH_CAP {
                            let mut raw = splitter.flush_pending_line();
                            let mut excess = raw.split_off(PARTIAL_FLUSH_CAP);
                            // 截断点同样不能劈开多字节字符：用 complete_len 精确对齐字符边界
                            let complete = decoder.complete_len(&raw);
                            if complete < raw.len() {
                                let tail = raw.split_off(complete);
                                let mut new_excess = tail;
                                new_excess.extend_from_slice(&excess);
                                excess = new_excess;
                            }
                            if !excess.is_empty() {
                                let _ = splitter.feed(&excess);
                            }
                            let raw_text = decoder.decode(&raw);
                            let segments = colorize.process_line(&raw_text);
                            let text = strip_ansi(&raw_text);
                            if filter.should_show(&text) {
                                batch.push(LogEntryDto { ts_ms: now, text, segments, raw_hex: hex_of(&raw), partial: false });
                            }
                        }
                    } else {
                        // 超时分包：不按换行拆，整段累积到 time_buf，靠空闲封行输出为时间块
                        time_buf.extend_from_slice(&data);
                        // 长流防护：time 分包同理——time_buf 超限先输出为时间块（partial=false），
                        // 避免连续流下无限累积、空闲才一次性吐出巨块。同样只取前 CAP 字节、余量回填。
                        if time_buf.len() >= PARTIAL_FLUSH_CAP {
                            let mut raw = std::mem::take(&mut time_buf);
                            if raw.len() > PARTIAL_FLUSH_CAP {
                                let mut excess = raw.split_off(PARTIAL_FLUSH_CAP);
                                // 同上：截断点不能劈开多字节字符
                                let complete = decoder.complete_len(&raw);
                                if complete < raw.len() {
                                    let mut tail = raw.split_off(complete);
                                    tail.extend_from_slice(&excess);
                                    excess = tail;
                                }
                                time_buf.extend_from_slice(&excess);
                            }
                            let raw_text = decoder.decode(&raw);
                            let segments = colorize.process_line(&raw_text);
                            let text = strip_ansi(&raw_text);
                            if filter.should_show(&text) {
                                batch.push(LogEntryDto { ts_ms: now, text, segments, raw_hex: hex_of(&raw), partial: false });
                            }
                        }
                    }
                        }
                    }
                    recv(heartbeat) -> _ => {
                        // 空闲封行：无换行的残余数据在 idle_timeout 后刷出（未结束部分行，前端续行）
                        // （时间戳取最后活动时刻；对齐 ADR-0008 智能分包语义）
                        // 空闲封行条目的 partial 仅在 line 分包下为 true（未结束部分行，前端续接亂断行，不把提示符与后续命令拆成两行）；time 分包下为 false（时间块=独立一行）
                        let idle_elapsed = now_mono_ms().saturating_sub(last_data_ms) >= options.idle_timeout_ms;
                        if options.split_mode == "line" {
                            if splitter.pending_bytes() > 0 && idle_elapsed {
                                let mut raw = splitter.flush_pending_line();
                                // 切点落在多字节字符中间时把末尾不完整序列留回 pending：
                                // 下一批字节到齐后前端 partial 续行会把它接回同一行，避免解出 U+FFFD。
                                let complete = decoder.complete_len(&raw);
                                if complete < raw.len() {
                                    let tail = raw.split_off(complete);
                                    let _ = splitter.feed(&tail);
                                }
                                if !raw.is_empty() {
                                    let raw_text = decoder.decode(&raw);
                                    let segments = colorize.process_line(&raw_text);
                                    let text = strip_ansi(&raw_text);
                                    if filter.should_show(&text) {
                                        batch.push(LogEntryDto { ts_ms: last_data_ms, text, segments, raw_hex: hex_of(&raw), partial: true });
                                    }
                                }
                            }
                        } else if !time_buf.is_empty() && idle_elapsed {
                            let raw = std::mem::take(&mut time_buf);
                            let raw_text = decoder.decode(&raw);
                            let segments = colorize.process_line(&raw_text);
                            let text = strip_ansi(&raw_text);
                            if filter.should_show(&text) {
                                batch.push(LogEntryDto { ts_ms: last_data_ms, text, segments, raw_hex: hex_of(&raw), partial: false });
                            }
                        }
                        if !batch.is_empty() && last_flush.elapsed() >= Duration::from_millis(30) {
                            ev.entries(&batch);
                            batch.clear();
                            last_flush = std::time::Instant::now();
                        }
                    }
                }
                if stop_l.load(Ordering::Relaxed) {
                    if options.split_mode == "line" {
                        for raw in splitter.flush() {
                            let raw_text = decoder.decode(&raw);
                            let segments = colorize.process_line(&raw_text);
                            let text = strip_ansi(&raw_text);
                            if filter.should_show(&text) {
                                batch.push(LogEntryDto { ts_ms: now_mono_ms(), text, segments, raw_hex: hex_of(&raw), partial: false });
                            }
                        }
                    } else if !time_buf.is_empty() {
                        let raw = std::mem::take(&mut time_buf);
                        let raw_text = decoder.decode(&raw);
                        let segments = colorize.process_line(&raw_text);
                        let text = strip_ansi(&raw_text);
                        if filter.should_show(&text) {
                            batch.push(LogEntryDto { ts_ms: now_mono_ms(), text, segments, raw_hex: hex_of(&raw), partial: false });
                        }
                    }
                    if !batch.is_empty() {
                        ev.entries(&batch);
                    }
                    break;
                }
            }
        }).map_err(|e| e.to_string())?);

        // ── 绘图线程 ──
        let plot_q = bus.subscribe("plot");
        let stop_p = stop.clone();
        let plot_store = self.plot.clone();
        let fmt_shared = Arc::clone(&self.plot_format); // 活引用：热切换写入对线程可见
        let plot_names = Arc::clone(&self.plot_names);
        let fmt_ver = self.plot_fmt_ver.clone();
        threads.push(
            std::thread::Builder::new()
                .name("plot".into())
                .spawn(move || {
                    // ASCII 自动通道：列数变化时按新宽度重建存储（首帧锁定后不再抖动）
                    fn is_auto_ascii(fmt: &Option<maxcom_core::plot::format::DataFormat>) -> bool {
                        matches!(
                            fmt.as_ref(),
                            Some(maxcom_core::plot::format::DataFormat::AsciiDelimited {
                                channel_count: 0,
                                ..
                            })
                        )
                    }
                    let mut cur_ver = fmt_ver.load(Ordering::Relaxed);
                    let mut parser: Option<Box<dyn FrameParser>> = fmt_shared
                        .lock()
                        .unwrap()
                        .as_ref()
                        .and_then(|f| make_parser(f).ok());
                    loop {
                        match plot_q.recv_timeout(Duration::from_millis(200)) {
                            Ok(data) => {
                                let ver = fmt_ver.load(Ordering::Relaxed);
                                if ver != cur_ver {
                                    // 格式热切换：按最新配置重建 parser
                                    cur_ver = ver;
                                    parser = fmt_shared
                                        .lock()
                                        .unwrap()
                                        .as_ref()
                                        .and_then(|f| make_parser(f).ok());
                                }
                                if let Some(p) = parser.as_mut() {
                                    drop(plot_store.lock().unwrap()); // 解析在锁外；push 时短暂加锁
                                    let mut frames = Vec::new();
                                    p.feed(&data, &mut |f| frames.push(f));
                                    let fmt = fmt_shared.lock().unwrap();
                                    let auto = is_auto_ascii(&fmt);
                                    let package_mode =
                                        matches!(
                                        fmt.as_ref(),
                                        Some(maxcom_core::plot::format::DataFormat::AsciiDelimited {
                                            split: maxcom_core::plot::format::AsciiSplit::Package,
                                            ..
                                        })
                                    );
                                    drop(fmt);
                                    let names = p.channel_names();
                                    if !names.is_empty() {
                                        let mut pn = plot_names.lock().unwrap();
                                        if *pn != names {
                                            *pn = names;
                                        }
                                    }
                                    let mut store = plot_store.lock().unwrap();
                                    if package_mode {
                                        // 分包：整行 = 单通道样本序列，多通道按行轮转，新包整通道覆盖
                                        for (rr, f) in frames.into_iter().enumerate() {
                                            let chn = store.channel_count().max(1);
                                            store.replace_channel(rr % chn, &f);
                                        }
                                    } else {
                                        for f in frames {
                                            if auto && store.channel_count() != f.len() {
                                                let cap = store.capacity();
                                                *store = ChannelStore::new(f.len(), cap);
                                            }
                                            store.push_frame(&f);
                                        }
                                    }
                                }
                            }
                            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                        }
                        if stop_p.load(Ordering::Relaxed) {
                            break;
                        }
                    }
                })
                .map_err(|e| e.to_string())?,
        );

        *guard = Some(Active {
            stop,
            threads,
            write,
            stats,
            cmd_tx,
            label: label.clone(),
            kind,
            dtr,
            rts,
            bus,
            status,
        });
        self.events.state(&ConnState::up(label).with_kind(kind));
        Ok(())
    }

    /// 断开当前会话（含中止进行中的连接尝试与自动重连循环）。
    /// 加锁顺序：先 `active` 再 `connecting`（与 `begin_connect` 一致）。
    pub fn disconnect(&self) {
        let taken = self.active.lock().unwrap().take();
        // 进行中的连接尝试一并作废：用户点「取消」时不需等 open 返回
        self.cancel_connect();
        if let Some(mut a) = taken {
            a.stop.store(true, Ordering::Relaxed);
            for t in a.threads.drain(..) {
                let _ = t.join();
            }
            *self.last_config.lock().unwrap() = None;
            self.events.state(&ConnState::down(a.label, None));
        }
    }

    /// 发送数据（文本/hex + 可选换行）。TX 计入统计。
    pub fn send(&self, payload: &SendPayload) -> Result<usize, String> {
        let bytes = payload.encode()?;
        let n = bytes.len();
        let guard = self.active.lock().unwrap();
        match &*guard {
            Some(a) => {
                a.write
                    .lock()
                    .unwrap()
                    .write_all(&bytes)
                    .map_err(|e| e.to_string())?;
                a.stats.record_tx(n);
                // 发送侧同样入环（MCP read_io 需要能回看自己发了什么）
                self.io_ring
                    .lock()
                    .unwrap()
                    .push(IoDir::Tx, &bytes, unix_ms());
                // 本地回显：设备不回显时也能在收发区看到自己发了什么。
                // 只投给 "log"，避免发送内容被绘图线程当成接收帧解析。
                if payload.echo {
                    a.bus.publish_to("log", &bytes);
                }
                Ok(n)
            }
            None => Err("未连接".into()),
        }
    }

    /// 调整终端/PTY 窗口尺寸（SSH 会同步向远端发送 WindowChange 报文）。
    pub fn resize_pty(&self, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self.active.lock().unwrap();
        match &*guard {
            Some(a) => a
                .write
                .lock()
                .unwrap()
                .resize_pty(cols, rows)
                .map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    /// 在**当前会话连接**上做 X/Y/ZMODEM 文件传输（烧录页 BL 交互）。
    ///
    /// 传输期间链路被协议独占：先断开会话（释放底层串口/连接句柄），再用同一配置
    /// 重新打开一条全双工连接专供 modem 协议使用，传输结束后自动重连恢复原会话。
    /// 对任意传输模式（串口/TCP/Telnet/SSH/UDP）通用。
    #[cfg(feature = "serial")]
    pub fn modem_transfer(
        &self,
        protocol: super::transport::ModemProtocol,
        path: String,
        on_progress: impl Fn(&super::transport::ModemProgress),
    ) -> Result<(), String> {
        // 新传输开始：复位取消位（前端停止按钮在传输期间置位）
        self.modem_cancel.store(false, Ordering::SeqCst);
        let config = self
            .last_config
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "未连接，无法执行 modem 传输".to_string())?;

        // 1. 断开当前会话以释放底层句柄（串口不能双开；网络重开无害）
        self.disconnect();
        // 2. 用同一配置重开一条全双工连接专供 modem
        let pair = super::transport::open(&config).map_err(|e| e.to_string())?;
        // 3. 合成全双工设备 + 跑协议（取消位与命令层共享，传输线程内检查）
        let mut duplex = super::transport::modem::Duplex {
            read: pair.read,
            write: pair.write,
            cancel: self.modem_cancel.clone(),
        };
        let file = std::fs::File::open(&path).map_err(|e| format!("打开文件失败: {e}"))?;
        let total = file.metadata().map(|m| m.len()).unwrap_or(0);
        let res = super::transport::modem::run_modem_on(
            &mut duplex,
            protocol,
            file,
            &path,
            total,
            &self.modem_cancel,
            &on_progress,
        );
        // 4. 丢弃 duplex（关闭临时连接）
        drop(duplex);
        // 5. 重连恢复原会话（即使传输失败也尽量恢复连接）
        if let Err(e) = self.connect(config) {
            // 重连失败不覆盖原传输错误；仅记录
            eprintln!("modem_transfer 后重连失败: {e}");
        }
        res
    }

    /// 强制停止当前 modem 传输（置位取消位；协议层在下一次轮询/读取时退出）。
    /// 无传输进行时调用无害（下次传输开始会复位）。
    pub fn cancel_modem_transfer(&self) {
        self.modem_cancel.store(true, Ordering::SeqCst);
    }

    pub fn set_log_options(&self, o: LogOptions) {
        *self.log_options.lock().unwrap() = o.clone();
        if let Some(a) = &*self.active.lock().unwrap() {
            let _ = a.cmd_tx.send(Cmd::SetLogOptions(o));
        }
    }

    pub fn set_filters(&self, rules: Vec<FilterRule>) {
        *self.filters.lock().unwrap() = rules.clone();
        if let Some(a) = &*self.active.lock().unwrap() {
            let _ = a.cmd_tx.send(Cmd::SetFilters(rules));
        }
    }

    pub fn set_color_rules(&self, master: bool, ansi_yield: bool, rules: Vec<ColorRule>) {
        *self.colors.lock().unwrap() = (master, ansi_yield, rules.clone());
        if let Some(a) = &*self.active.lock().unwrap() {
            let _ = a.cmd_tx.send(Cmd::SetColorRules {
                master,
                ansi_yield,
                rules,
            });
        }
    }

    pub fn clear_log(&self) {
        if let Some(a) = &*self.active.lock().unwrap() {
            let _ = a.cmd_tx.send(Cmd::ClearLog);
        }
    }
}

impl Drop for SessionManager {
    fn drop(&mut self) {
        self.cancel_capture(); // 回收未保存的捕获临时文件
        self.disconnect();
    }
}

impl SendPayload {
    fn encode(&self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        if let Some(text) = &self.text {
            out.extend_from_slice(text.as_bytes());
        }
        if let Some(hex) = &self.hex {
            let clean: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
            let bytes = decode_hex(&clean)?;
            out.extend_from_slice(&bytes);
        }
        match self.newline.as_str() {
            "\n" => out.push(b'\n'),
            "\r" => out.push(b'\r'),
            "\r\n" => out.extend_from_slice(b"\r\n"),
            _ => {}
        }
        Ok(out)
    }
}

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err("hex 长度必须为偶数".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("非法 hex: {e}")))
        .collect()
}

fn hex_of(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{b:02X}"));
    }
    s
}

/// 自动重连退避：第 n 次尝试前等待的毫秒数。
/// base、2×、4×、8×…… 上限 15s —— 设备缺失/网络不可达时不要高频重试打日志。
fn reconnect_backoff_ms(base: u64, attempt: u32) -> u64 {
    let shift = attempt.saturating_sub(1).min(3);
    base.saturating_mul(1u64 << shift).min(15_000)
}

/// 进程内单调钟基准（`now_mono_ms` 的 0 点）。
/// **必须与 `mono_epoch_wall_ms` 复用同一静态**：两者的相对差就是"墙钟-单调钟"换算，
/// 若各自 `OnceLock` 在不同的首次调用时刻初始化，换算基准就错了。
fn mono_epoch() -> std::time::Instant {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    *START.get_or_init(std::time::Instant::now)
}

fn now_mono_ms() -> u64 {
    // 微秒取整再除 1000：直接用 `as_millis()` 会把单调钟截断到毫秒，
    // 与 `unix_ms()`（同样是毫秒截断）相减时两个截断误差相互抵消，
    // 使 "墙钟−单调钟" 的差出现 ±1ms 的非单调抖动（实测 50ms 采样得 0ms 差）。
    (mono_epoch().elapsed().as_micros() / 1000) as u64
}

pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 单调钟 0 点对应的墙钟（Unix 毫秒）。
///
/// 为什么必须**每次实时重算**而不是启动时取一次：
/// - `ts_ms` 走 `Instant`（`now_mono_ms`），它在**系统休眠/挂起期间不前进**，
///   而墙钟照常前进。软件长时间不关、中间跨过一次系统睡眠后，`Instant` 累计值
///   会比真实经过时间**少**掉睡眠时长。
/// - 若"墙钟−单调钟"的差在启动时取一次就缓存，则 `anchor + ts_ms` 会**偏慢**
///   （睡眠多久就慢多久，几十秒到几分钟量级），且重开软件就恢复正常——
///   正是"软件时间比系统时间慢几十秒、重启后好了"的现象。
/// - 每次实时重算后，`ts_ms` 只承担"批次内相对间隔"的作用（毫秒级精度、不受对时跳变影响），
///   而其**绝对基准每批都与当前墙钟对齐**，因此不会累积漂移。
fn mono_epoch_wall_ms() -> i64 {
    unix_ms() as i64 - now_mono_ms() as i64
}

/// 把一条 monotonic 时间戳（`ts_ms`，以 `mono_epoch()` 为 0 点）换算成当前墙钟 Unix 毫秒。
pub fn wall_from_mono_ms(ts_ms: u64) -> i64 {
    mono_epoch_wall_ms() + ts_ms as i64
}

/// 当前墙钟基准（Unix 毫秒），供事件层作为 `epoch_anchor_ms` 下发。
/// 语义：`显示墙钟 = epoch_anchor_ms + ts_ms`；与 `wall_from_mono_ms(0)` 等价。
pub fn wall_anchor_ms() -> i64 {
    mono_epoch_wall_ms()
}

#[cfg(test)]
mod io_ring_tests {
    use super::*;

    fn bytes(n: usize) -> Vec<u8> {
        vec![0xAB; n]
    }

    #[test]
    fn since_returns_chunks_after_given_seq_in_order() {
        let mut ring = IoRing::default();
        ring.push(IoDir::Rx, b"hello", 1_000);
        ring.push(IoDir::Tx, b"world", 1_001);

        let all = ring.since(0, usize::MAX);
        assert_eq!(all.len(), 2);
        assert_eq!(
            (all[0].seq, all[0].dir, all[0].ts_ms),
            (1, IoDir::Rx, 1_000)
        );
        assert_eq!(all[0].data, b"hello");
        assert_eq!((all[1].seq, all[1].dir), (2, IoDir::Tx));
        assert_eq!(all[1].data, b"world");
        assert_eq!(ring.max_seq(), 2);

        // 续读语义：用上次返回的最大 seq 再读，不重不漏
        assert!(ring.since(2, usize::MAX).is_empty());
        let tail = ring.since(1, usize::MAX);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].seq, 2);
    }

    #[test]
    fn oversized_write_is_split_into_bounded_chunks() {
        let mut ring = IoRing::default();
        let big = bytes(IO_CHUNK_MAX * 2 + 7);
        ring.push(IoDir::Rx, &big, 42);
        let chunks = ring.since(0, usize::MAX);
        // 2 个满块 + 1 个残块
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.data.len() <= IO_CHUNK_MAX));
        assert_eq!(
            chunks.iter().map(|c| c.data.len()).sum::<usize>(),
            big.len(),
            "切分不得丢字节"
        );
        assert_eq!(
            chunks.iter().map(|c| c.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn ring_drops_oldest_and_never_exceeds_capacity() {
        let mut ring = IoRing::default();
        let step = 64 * 1024;
        for _ in 0..16 {
            ring.push(IoDir::Rx, &bytes(step), 7);
        }
        // 16 × 64 KiB = 1 MiB 写入，环只能装 512 KiB
        assert_eq!(ring.bytes, IO_RING_CAP, "环占用应被钳到容量上限");
        assert_eq!(ring.max_seq(), (16 * step).div_ceil(IO_CHUNK_MAX) as u64);
        assert!(ring.oldest_seq() > 1, "最旧块应已被丢弃");

        let kept = ring.since(0, usize::MAX);
        let total: usize = kept.iter().map(|c| c.data.len()).sum();
        assert!(total <= IO_RING_CAP);
        assert_eq!(kept.first().unwrap().seq, ring.oldest_seq());
        assert_eq!(kept.last().unwrap().seq, ring.max_seq());
    }

    #[test]
    fn since_caps_returned_bytes_but_always_returns_first_chunk() {
        let mut ring = IoRing::default();
        for i in 0..4 {
            ring.push(IoDir::Rx, &bytes(100), i);
        }
        // 限额 250：前两块 200 ≤ 250，第三块会越界 → 只回两块
        assert_eq!(ring.since(0, 250).len(), 2);
        // 限额小于单块：仍要回首块，否则客户端永远推不动
        let got = ring.since(0, 10);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].data.len(), 100);
    }

    #[test]
    fn clear_empties_ring_but_keeps_sequence_monotonic() {
        let mut ring = IoRing::default();
        ring.push(IoDir::Rx, b"abc", 1);
        ring.clear();
        assert!(ring.since(0, usize::MAX).is_empty());
        assert_eq!(ring.oldest_seq(), ring.max_seq());

        // 序号不回退：清空后新块仍大于旧序号，客户端按旧 seq 续读不会错位
        ring.push(IoDir::Tx, b"d", 2);
        assert_eq!(ring.max_seq(), 2);
        assert_eq!(ring.since(1, usize::MAX).len(), 1);
    }
}

#[cfg(test)]
mod capture_sink_tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn sink_flushes_on_chunk_boundary_and_tracks_total() {
        let mut sink = CaptureSink::new().unwrap();
        let target = sink.path.clone();
        // 小写累计在内存 buf，未达 CHUNK 不落盘
        sink.write(&[1u8; 10]).unwrap();
        assert_eq!(sink.total, 10);
        // 一次写满一个 CHUNK：触发 flush 落盘
        sink.write(&[2u8; CAP_CHUNK]).unwrap();
        assert_eq!(sink.total, 10 + CAP_CHUNK as u64);
        sink.finish().unwrap();

        let mut got = Vec::new();
        std::fs::File::open(&target)
            .unwrap()
            .read_to_end(&mut got)
            .unwrap();
        assert_eq!(got.len(), 10 + CAP_CHUNK);
        assert!(got[..10].iter().all(|&b| b == 1));
        assert!(got[10..].iter().all(|&b| b == 2));
        let _ = std::fs::remove_file(&target);
    }

    #[test]
    fn sink_write_is_best_effort_across_many_small_chunks() {
        let mut sink = CaptureSink::new().unwrap();
        let target = sink.path.clone();
        let total = 100_000u32;
        for _ in 0..total {
            sink.write(b"ab").unwrap();
        }
        assert_eq!(sink.total, (total as u64) * 2);
        sink.finish().unwrap();
        let len = std::fs::metadata(&target).unwrap().len();
        assert_eq!(len, (total as u64) * 2);
        let _ = std::fs::remove_file(&target);
    }
}

#[cfg(test)]
mod wall_clock_tests {
    use super::*;

    /// `wall_from_mono_ms(now_mono_ms())` 必须 ≈ 当前真实墙钟。
    ///
    /// 这是用户可见语义的正确性锚点：前端按 `显示墙钟 = epoch_anchor_ms + ts_ms` 渲染，
    /// `ts_ms` 来自单调钟。若换算基准偏离当前墙钟，日志时间就会整体偏快/偏慢。
    /// 容差 1s：覆盖毫秒截断、采样间隔与调度抖动。
    #[test]
    fn wall_conversion_tracks_current_wall_clock() {
        let before = unix_ms() as i64;
        let wall = wall_from_mono_ms(now_mono_ms());
        let after = unix_ms() as i64;
        assert!(
            wall >= before - 1000 && wall <= after + 1000,
            "换算墙钟 {wall} 偏离真实区间 [{before}, {after}]"
        );
    }

    /// `anchor` 是"单调钟 0 点对应的墙钟"，两个钟同步流逝 → 该差在两次采样间应近乎不变。
    /// 这条断言锁住"实时重算"的语义：无论缓存与否，只要换算基准正确，差值就该稳定在 0 附近。
    /// （真正的漂移场景——系统休眠使单调钟滞后于墙钟——无法在单测里伪造，
    ///  只能在实现层通过 `mono_epoch_wall_ms` 每批实时重算来规避，见其文档注释。）
    #[test]
    fn wall_anchor_is_stable_across_samples() {
        let a1 = wall_anchor_ms();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let a2 = wall_anchor_ms();
        let delta = (a2 - a1).abs();
        // 两个钟都走 50ms，差值应≈0；给 5ms 余量吸收截断与调度抖动。
        // 若某天有人把 anchor 改成"固定墙钟常量"（不含单调钟修正），这里会立刻爆掉。
        assert!(delta <= 5, "anchor 两次采样差 {delta}ms，换算基准不稳定");
    }
}
