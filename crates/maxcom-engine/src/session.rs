//! 会话编排：连接生命周期（含自动重连）+ 引擎线程组 + 对上层的批量回调。
//!
//! 线程模型（ADR-0015 各引擎独立解析）：
//! - 读线程：阻塞读传输 → 发布 raw 事件 + Bus 扇出；**掉线时按退避重连**（可关）
//! - 日志线程：Bus 消费 → 分行 → 解码 → 染色 → 过滤 → 批量 entry 回调（~30ms 合批）
//! - 绘图线程：Bus 消费 → 帧解析 → ChannelStore（前端轮询快照，零事件风暴）
//!
//! 上层通过 [`SessionEvents`] trait 接收回调；测试用内存记录器验证。

use crossbeam_channel::{bounded, select, tick, Sender};
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 捕获缓冲上限（64 MiB，超出丢弃并计数）
const CAPTURE_CAP: usize = 64 * 1024 * 1024;

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
    pub series: Vec<Vec<f64>>,
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
    /// 共享写句柄：自动重连成功后由读线程换新
    write: Arc<Mutex<Box<dyn super::transport::TransportWrite>>>,
    stats: Arc<StatsTracker>,
    cmd_tx: Sender<Cmd>,
    label: String,
    dtr: Arc<AtomicBool>,
    rts: Arc<AtomicBool>,
}

/// 会话管理器：同一时刻至多一个活动连接（ADR-0016 单连接，多实例满足多端口）。
pub struct SessionManager {
    active: Mutex<Option<Active>>,
    events: Arc<dyn SessionEvents>,
    plot: Arc<Mutex<ChannelStore>>,
    plot_format: Mutex<Option<maxcom_core::plot::format::DataFormat>>,
    /// 掉线自动重连开关
    auto_reconnect: Arc<AtomicBool>,
    /// 重连间隔（ms，测试可调小）
    reconnect_delay_ms: AtomicU64,
    /// 接收捕获缓冲（Some=捕获中）
    capture: Arc<Mutex<Option<Vec<u8>>>>,
    capture_dropped: Arc<AtomicU64>,
}

impl SessionManager {
    pub fn new(events: Arc<dyn SessionEvents>) -> Self {
        Self {
            active: Mutex::new(None),
            events,
            plot: Arc::new(Mutex::new(ChannelStore::new(1, 10000))),
            plot_format: Mutex::new(None),
            auto_reconnect: Arc::new(AtomicBool::new(true)),
            reconnect_delay_ms: AtomicU64::new(2000),
            capture: Arc::new(Mutex::new(None)),
            capture_dropped: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn is_connected(&self) -> bool {
        self.active.lock().unwrap().is_some()
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

    /// 开始捕获接收数据（清空缓冲从头计）
    pub fn start_capture(&self) {
        self.capture_dropped.store(0, Ordering::Relaxed);
        *self.capture.lock().unwrap() = Some(Vec::new());
    }

    pub fn stop_capture(&self) {
        *self.capture.lock().unwrap() = None;
    }

    /// 停止捕获并把缓冲写入文件，返回字节数。
    pub fn save_capture(&self, path: &str) -> Result<u64, String> {
        let buf = self.capture.lock().unwrap().take();
        let dropped = self.capture_dropped.load(Ordering::Relaxed);
        let Some(buf) = buf else {
            return Err("未在捕获中".into());
        };
        let n = buf.len() as u64;
        std::fs::write(path, &buf).map_err(|e| format!("写入失败: {e}"))?;
        if dropped > 0 {
            return Ok(n); // 调用方可对比 n 与预期判断截断；详细 dropped 计数经 capture_state 查询
        }
        Ok(n)
    }

    /// 捕获状态：(是否捕获中, 已捕获字节, 因超限丢弃的字节)
    pub fn capture_state(&self) -> (bool, u64, u64) {
        let g = self.capture.lock().unwrap();
        (
            g.is_some(),
            g.as_ref().map(|b| b.len() as u64).unwrap_or(0),
            self.capture_dropped.load(Ordering::Relaxed),
        )
    }

    /// 设置绘图数据格式（切换时清空缓冲）
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
        let write = Arc::new(Mutex::new(pair.write));
        let dtr = Arc::new(AtomicBool::new(false));
        let rts = Arc::new(AtomicBool::new(false));
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
        let dropped_r = self.capture_dropped.clone();
        let label_r = label.clone();
        let cfg_r = config.clone();
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
                                    ev.raw(&buf[..n]);
                                    bus_r.publish(&buf[..n]);
                                    // 捕获
                                    if let Some(cap) = &mut *capture_r.lock().unwrap() {
                                        if cap.len() + n <= CAPTURE_CAP {
                                            cap.extend_from_slice(&buf[..n]);
                                        } else {
                                            dropped_r.fetch_add(n as u64, Ordering::Relaxed);
                                        }
                                    }
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
                        // ── 掉线：自动重连循环 ──
                        loop {
                            if stop_r.load(Ordering::Relaxed) || !auto_r.load(Ordering::Relaxed) {
                                break 'session;
                            }
                            // 分片睡眠，保证 stop 能及时生效
                            let step = 100u64;
                            let mut waited = 0u64;
                            while waited < delay_ms {
                                if stop_r.load(Ordering::Relaxed) {
                                    break 'session;
                                }
                                std::thread::sleep(Duration::from_millis(
                                    step.min(delay_ms - waited),
                                ));
                                waited += step;
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
                                    ev.state(&ConnState {
                                        connected: true,
                                        label: label_r.clone(),
                                        error: None,
                                    });
                                    continue 'session;
                                }
                                Err(_) => continue, // 继续退避重试
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
        let cmd_rx_log = cmd_rx.clone();
        threads.push(std::thread::Builder::new().name("logview".into()).spawn(move || {
            let detector = EncodingDetector;
            let mut splitter = LineSplitter::new();
            let mut colorize = ColorizeEngine::new(true);
            let mut filter = FilterEngine::new();
            let mut options = LogOptions::default();
            let heartbeat = tick(Duration::from_millis(50));
            let mut batch: Vec<LogEntryDto> = Vec::new();
            let mut last_flush = std::time::Instant::now();
            let mut last_data_ms = now_mono_ms();
            loop {
                select! {
                    recv(cmd_rx_log) -> msg => {
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
                            last_data_ms = now;
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
                        // 空闲封行：无换行的残余数据在 idle_timeout 后作为一行产出
                        // （时间戳取最后活动时刻；对齐 ADR-0008 智能分包语义）
                        if splitter.pending_bytes() > 0
                            && now_mono_ms().saturating_sub(last_data_ms) >= options.idle_timeout_ms
                        {
                            let raw = splitter.flush_pending_line();
                            let text = detector.decode(&raw, &options.encoding);
                            let segments = colorize.process_line(&text);
                            if filter.should_show(&text) {
                                batch.push(LogEntryDto { ts_ms: last_data_ms, text, segments });
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
                                    drop(plot_store.lock().unwrap()); // 解析在锁外；push 时短暂加锁
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
            write,
            stats,
            cmd_tx,
            label: label.clone(),
            dtr,
            rts,
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

pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
