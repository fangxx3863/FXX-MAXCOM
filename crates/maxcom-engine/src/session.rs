//! 会话编排：连接生命周期 + 引擎线程组 + 对上层（src-tauri）的批量回调。
//!
//! 线程模型（ADR-0015 各引擎独立解析）：
//! - 读线程：阻塞读传输 → 发布 raw 事件 + Bus 扇出
//! - 日志线程：Bus 消费 → 分行 → 解码 → 染色 → 过滤 → 批量 entry 回调（~30ms 合批）
//! - 绘图：Bus 消费 → 帧解析 → ChannelStore（前端轮询快照，零事件风暴）
//!
//! 上层通过 [`SessionEvents`] trait 接收回调；测试用内存记录器验证。

use crossbeam_channel::{bounded, select, tick, Receiver, Sender};
use maxcom_core::bus::Bus;
use maxcom_core::colorize::{ColorRule, ColorizeEngine};
use maxcom_core::encoding::EncodingDetector;
use maxcom_core::filter::{FilterEngine, FilterRule};
use maxcom_core::framing::TimestampMode;
use maxcom_core::plot::parser::{make_parser, FrameParser};
use maxcom_core::plot::{ChannelMetrics, ChannelStore};
use maxcom_core::splitter::LineSplitter;
use maxcom_core::stats::{StatsSnapshot, StatsTracker};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 日志条目 DTO（segments 已染色；前端直接渲染）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntryDto {
    pub ts_ms: u64,
    pub text: String,
    pub segments: Vec<maxcom_core::colorize::ColoredSegment>,
}

/// 绘图快照 DTO（前端 ~50ms 轮询一次）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlotSnapshotDto {
    pub channel_count: usize,
    pub total_points: usize,
    /// 每通道下采样序列（旧→新）
    pub series: Vec<Vec<f64>>,
    /// 每通道统计指标
    pub metrics: Vec<Option<ChannelMetrics>>,
}

/// 连接状态事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnState {
    pub connected: bool,
    pub label: String,
    pub error: Option<String>,
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
    /// "auto" / "utf-8" / "gbk" / ...
    pub encoding: String,
}

impl Default for LogOptions {
    fn default() -> Self {
        Self {
            idle_timeout_ms: 100,
            timestamp_mode: TimestampMode::Absolute,
            encoding: "auto".into(),
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

/// 一个活动会话的全部资源
struct Active {
    stop: Arc<AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
    write: Mutex<Box<dyn super::transport::TransportWrite>>,
    stats: Arc<StatsTracker>,
    cmd_tx: Sender<Cmd>,
    label: String,
}

/// 会话管理器：同一时刻至多一个活动连接（ADR-0016 单连接，多实例满足多端口）。
pub struct SessionManager {
    active: Mutex<Option<Active>>,
    events: Arc<dyn SessionEvents>,
    /// 绘图数据存储（连接期间由绘图线程写入；断开后保留供查看）
    plot: Arc<Mutex<ChannelStore>>,
    plot_format: Mutex<Option<maxcom_core::plot::format::DataFormat>>,
}

impl SessionManager {
    pub fn new(events: Arc<dyn SessionEvents>) -> Self {
        Self {
            active: Mutex::new(None),
            events,
            plot: Arc::new(Mutex::new(ChannelStore::new(1, 10000))),
            plot_format: Mutex::new(None),
        }
    }

    pub fn is_connected(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }

    /// 设置绘图数据格式（下次连接生效；切换时清空缓冲）
    pub fn set_plot_format(&self, fmt: maxcom_core::plot::format::DataFormat) {
        let ch = fmt.channel_count() as usize;
        *self.plot_format.lock().unwrap() = Some(fmt);
        *self.plot.lock().unwrap() = ChannelStore::new(ch.max(1), 10000);
    }

    /// 绘图快照（前端轮询）
    pub fn plot_snapshot(&self, max_points: usize) -> PlotSnapshotDto {
        let store = self.plot.lock().unwrap();
        let mut dto = PlotSnapshotDto {
            channel_count: store.channel_count(),
            total_points: store.len(),
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

    /// 打开连接并启动引擎线程组。
    pub fn connect(&self, config: super::transport::ConnConfig) -> Result<(), String> {
        config.validate()?;
        let mut guard = self.active.lock().unwrap();
        if guard.is_some() {
            return Err("已有活动连接（单连接设计，先断开再连）".into());
        }
        let pair = super::transport::open(&config).map_err(|e| e.to_string())?;
        let label = pair.label.clone();

        let stop = Arc::new(AtomicBool::new(false));
        let bus = Arc::new(Bus::new());
        let stats = Arc::new(StatsTracker::new());
        let (cmd_tx, cmd_rx) = bounded::<Cmd>(64);
        let mut threads = Vec::new();

        // ── 读线程 ──
        let mut read_half = pair.read;
        let ev = self.events.clone();
        let stop_r = stop.clone();
        let bus_r = bus.clone();
        let stats_r = stats.clone();
        let label_r = label.clone();
        let log_q: Receiver<Vec<u8>> = bus.subscribe("log");
        let plot_q: Receiver<Vec<u8>> = bus.subscribe("plot");
        // 注意：log/plot 队列在下面两个线程消费；读线程只负责 publish
        drop(log_q);
        drop(plot_q);
        threads.push(
            std::thread::Builder::new()
                .name("reader".into())
                .spawn(move || {
                    let mut buf = [0u8; 4096];
                    while !stop_r.load(Ordering::Relaxed) {
                        match read_half.read(&mut buf) {
                            Ok(0) => continue, // 超时节拍
                            Ok(n) => {
                                stats_r.record_rx(n);
                                ev.raw(&buf[..n]);
                                bus_r.publish(&buf[..n]);
                            }
                            Err(e) => {
                                ev.state(&ConnState {
                                    connected: false,
                                    label: label_r.clone(),
                                    error: Some(e.to_string()),
                                });
                                break;
                            }
                        }
                    }
                })
                .map_err(|e| e.to_string())?,
        );

        // ── 日志线程 ──
        let log_q = bus.subscribe("log");
        let ev = self.events.clone();
        let stop_l = stop.clone();
        let epoch_ms = unix_ms();
        let mut last_base: Option<u64> = None;
        threads.push(std::thread::Builder::new().name("logview".into()).spawn(move || {
            let detector = EncodingDetector;
            let mut splitter = LineSplitter::new();
            let mut colorize = ColorizeEngine::new(true);
            let mut filter = FilterEngine::new();
            let mut options = LogOptions::default();
            let heartbeat = tick(Duration::from_millis(50));
            let mut batch: Vec<LogEntryDto> = Vec::new();
            let mut last_flush = std::time::Instant::now();
            loop {
                select! {
                    recv(cmd_rx) -> msg => {
                        match msg {
                            Ok(Cmd::SetLogOptions(o)) => options = o,
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
                            Ok(Cmd::ClearLog) => splitter.clear(),
                            Err(_) => break,
                        }
                    }
                    recv(log_q) -> data => {
                        if let Ok(data) = data {
                            let now = now_mono_ms();
                            for raw in splitter.feed(&data) {
                                let text = detector.decode(&raw, &options.encoding);
                                let segments = colorize.process_line(&text);
                                if filter.should_show(&text) {
                                    batch.push(LogEntryDto { ts_ms: now, text, segments });
                                }
                            }
                        }
                    }
                    recv(heartbeat) -> _ => {
                        // 合批刷新（~30ms）+ 时间戳格式化在回调侧完成
                        if !batch.is_empty() && last_flush.elapsed() >= Duration::from_millis(30) {
                            ev.entries(&batch);
                            batch.clear();
                            last_flush = std::time::Instant::now();
                        }
                    }
                }
                if stop_l.load(Ordering::Relaxed) {
                    // 收尾：刷残余行
                    for raw in splitter.flush() {
                        let text = detector.decode(&raw, &options.encoding);
                        let segments = colorize.process_line(&text);
                        if filter.should_show(&text) {
                            batch.push(LogEntryDto { ts_ms: now_mono_ms(), text, segments });
                        }
                    }
                    if !batch.is_empty() {
                        ev.entries(&batch);
                    }
                    break;
                }
            }
            let _ = (epoch_ms, &mut last_base); // 绝对时间戳格式化由前端用 ts_ms 完成
        }).map_err(|e| e.to_string())?);

        // ── 绘图线程 ──
        let plot_q = bus.subscribe("plot");
        let stop_p = stop.clone();
        let plot_store = self.plot.clone();
        let fmt = self.plot_format.lock().unwrap().clone();
        threads.push(
            std::thread::Builder::new()
                .name("plot".into())
                .spawn(move || {
                    let mut parser: Option<Box<dyn FrameParser>> =
                        fmt.as_ref().and_then(|f| make_parser(f).ok());
                    loop {
                        match plot_q.recv_timeout(Duration::from_millis(200)) {
                            Ok(data) => {
                                if let Some(p) = parser.as_mut() {
                                    let store = plot_store.lock().unwrap();
                                    drop(store); // 解析在锁外；push 时短暂加锁
                                    let mut frames = Vec::new();
                                    p.feed(&data, &mut |f| frames.push(f));
                                    let mut store = plot_store.lock().unwrap();
                                    for f in frames {
                                        store.push_frame(&f);
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
            write: Mutex::new(pair.write),
            stats,
            cmd_tx,
            label: label.clone(),
        });
        self.events.state(&ConnState {
            connected: true,
            label,
            error: None,
        });
        Ok(())
    }

    pub fn disconnect(&self) {
        let taken = self.active.lock().unwrap().take();
        if let Some(mut a) = taken {
            a.stop.store(true, Ordering::Relaxed);
            for t in a.threads.drain(..) {
                let _ = t.join();
            }
            self.events.state(&ConnState {
                connected: false,
                label: a.label,
                error: None,
            });
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
                Ok(n)
            }
            None => Err("未连接".into()),
        }
    }

    pub fn set_log_options(&self, o: LogOptions) {
        if let Some(a) = &*self.active.lock().unwrap() {
            let _ = a.cmd_tx.send(Cmd::SetLogOptions(o));
        }
    }

    pub fn set_filters(&self, rules: Vec<FilterRule>) {
        if let Some(a) = &*self.active.lock().unwrap() {
            let _ = a.cmd_tx.send(Cmd::SetFilters(rules));
        }
    }

    pub fn set_color_rules(&self, master: bool, ansi_yield: bool, rules: Vec<ColorRule>) {
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

fn now_mono_ms() -> u64 {
    use std::time::Instant;
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
