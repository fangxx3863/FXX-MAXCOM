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
use maxcom_core::encoding::EncodingDetector;
use maxcom_core::filter::{FilterEngine, FilterRule};
use maxcom_core::framing::TimestampMode;
use maxcom_core::plot::parser::{make_parser, FrameParser};
use maxcom_core::plot::{ChannelMetrics, ChannelStore};
use maxcom_core::splitter::LineSplitter;
use maxcom_core::stats::{StatsSnapshot, StatsTracker};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
}

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
        }
    }

    pub fn is_connected(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }

    /// 查询当前连接状态（主动查询，区别于被动 state 事件）。
    /// 读线程掉线但未走 disconnect() 清理时 active 可能残留；前端应在每次
    /// 连接/断开前调用本方法同步，避免“仅允许单连接”误报。
    pub fn conn_state(&self) -> ConnState {
        match &*self.active.lock().unwrap() {
            Some(a) => ConnState {
                connected: true,
                label: a.label.clone(),
                error: None,
            },
            None => ConnState {
                connected: false,
                label: String::new(),
                error: None,
            },
        }
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

    /// 打开连接并启动引擎线程组。
    pub fn connect(&self, config: super::transport::ConnConfig) -> Result<(), String> {
        config.validate()?;
        let mut guard = self.active.lock().unwrap();
        if guard.is_some() {
            return Err("已有活动连接（单连接设计，先断开再连）".into());
        }
        let pair = super::transport::open(&config).map_err(|e| e.to_string())?;
        let label = pair.label.clone();
        *self.last_config.lock().unwrap() = Some(config.clone());

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
                            if stop_r.load(Ordering::Relaxed) {
                                break 'session;
                            }
                            if !auto_r.load(Ordering::Relaxed) {
                                // 掉线且关闭自动重连：停止整个会话（日志/绘图线程随之退出）。
                                // 注意：active 暂不清空，由 conn_state() 上报 + 前端在连接/断开前同步兜底。
                                stop_r.store(true, Ordering::Relaxed);
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
        // 冷启动配置：连接前 set_filters/set_color_rules/set_log_options 可能已被调用，
        // 此处同步播种到日志线程，避免异步 cmd 与数据竞速导致前几行漏过滤
        let init_filters = self.filters.lock().unwrap().clone();
        let (init_master, init_ansi_yield, init_rules) = self.colors.lock().unwrap().clone();
        let init_lopts = self.log_options.lock().unwrap().clone();
        threads.push(std::thread::Builder::new().name("logview".into()).spawn(move || {
            let detector = EncodingDetector;
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
                            Ok(Cmd::ClearLog) => { splitter.clear(); time_buf.clear(); }
                            Err(_) => break,
                        }
                    }
                    recv(log_q) -> data => {
                        if let Ok(data) = data {
                            let now = now_mono_ms();
                            last_data_ms = now;
                            if options.split_mode == "line" {
                        for raw in splitter.feed(&data) {
                            let raw_text = detector.decode(&raw, &options.encoding);
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
                            let excess = raw.split_off(PARTIAL_FLUSH_CAP);
                            if !excess.is_empty() {
                                let _ = splitter.feed(&excess); // 尾段无换行，feed 仅回填 pending
                            }
                            let raw_text = detector.decode(&raw, &options.encoding);
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
                                time_buf.extend_from_slice(&raw.split_off(PARTIAL_FLUSH_CAP));
                            }
                            let raw_text = detector.decode(&raw, &options.encoding);
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
                                let raw = splitter.flush_pending_line();
                                let raw_text = detector.decode(&raw, &options.encoding);
                                let segments = colorize.process_line(&raw_text);
                                let text = strip_ansi(&raw_text);
                                if filter.should_show(&text) {
                                    batch.push(LogEntryDto { ts_ms: last_data_ms, text, segments, raw_hex: hex_of(&raw), partial: true });
                                }
                            }
                        } else if !time_buf.is_empty() && idle_elapsed {
                            let raw = std::mem::take(&mut time_buf);
                            let raw_text = detector.decode(&raw, &options.encoding);
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
                            let raw_text = detector.decode(&raw, &options.encoding);
                            let segments = colorize.process_line(&raw_text);
                            let text = strip_ansi(&raw_text);
                            if filter.should_show(&text) {
                                batch.push(LogEntryDto { ts_ms: now_mono_ms(), text, segments, raw_hex: hex_of(&raw), partial: false });
                            }
                        }
                    } else if !time_buf.is_empty() {
                        let raw = std::mem::take(&mut time_buf);
                        let raw_text = detector.decode(&raw, &options.encoding);
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
            *self.last_config.lock().unwrap() = None;
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
