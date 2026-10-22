//! 会话编排集成测试：TCP 回环验证 读→扇出→日志引擎→回调 / 发送 / 统计 / 过滤 全链路。

use maxcom_core::filter::FilterRule;
use maxcom_core::framing::TimestampMode;
use maxcom_engine::session::{
    ConnPhase, ConnState, IoDir, LogEntryDto, LogOptions, SendPayload, SessionEvents,
    SessionManager,
};
use maxcom_engine::transport::ConnConfig;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Recorder {
    raw: Mutex<Vec<u8>>,
    entries: Mutex<Vec<LogEntryDto>>,
    states: Mutex<Vec<ConnState>>,
}

impl SessionEvents for Recorder {
    fn raw(&self, data: &[u8]) {
        self.raw.lock().unwrap().extend_from_slice(data);
    }
    fn entries(&self, es: &[LogEntryDto]) {
        self.entries.lock().unwrap().extend(es.iter().cloned());
    }
    fn state(&self, s: &ConnState) {
        self.states.lock().unwrap().push(s.clone());
    }
}

/// 回显服务器：收到什么回什么（单连接逐批处理）
fn spawn_echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut s = stream;
            let _ = s.set_read_timeout(Some(Duration::from_millis(100)));
            loop {
                let mut buf = [0u8; 1024];
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if s.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
        }
    });
    port
}

fn wait_until<F: Fn() -> bool>(cond: F, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    cond()
}

fn tcp_cfg(port: u16) -> ConnConfig {
    ConnConfig::TcpClient {
        host: "127.0.0.1".into(),
        port,
    }
}

#[test]
fn full_pipeline_over_tcp_loopback() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());

    mgr.connect(tcp_cfg(port)).expect("connect");
    assert!(mgr.is_connected());

    // ── 发送：文本 + 换行；回显服务器原样返回 ──
    let n = mgr
        .send(&SendPayload {
            text: Some("hello".into()),
            hex: None,
            newline: "\r\n".into(),
            echo: false,
        })
        .expect("send");
    assert_eq!(n, 7);

    // 回显到达：raw 与日志行都应有内容
    assert!(
        wait_until(
            || rec.raw.lock().unwrap().len() >= 7,
            Duration::from_secs(3)
        ),
        "raw 未收到回显"
    );
    assert!(
        wait_until(
            || rec
                .entries
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.text.contains("hello")),
            Duration::from_secs(3)
        ),
        "日志行未产出"
    );

    // ── 统计：RX/TX 均应计数 ──
    let st = mgr.stats();
    assert!(st.rx_bytes >= 7, "rx={}", st.rx_bytes);
    assert!(st.tx_bytes >= 7, "tx={}", st.tx_bytes);

    // ── 过滤规则热更新：hide hello 后新行不再出现 ──
    mgr.set_filters(vec![FilterRule {
        name: "no-hello".into(),
        pattern: "hello".into(),
        action: "hide".into(),
        enabled: true,
    }]);
    let before = rec.entries.lock().unwrap().len();
    mgr.send(&SendPayload {
        text: Some("hello again".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    mgr.send(&SendPayload {
        text: Some("visible".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    wait_until(
        || {
            rec.entries
                .lock()
                .unwrap()
                .iter()
                .skip(before)
                .any(|e| e.text.contains("visible"))
        },
        Duration::from_secs(3),
    );
    let new_entries = rec.entries.lock().unwrap()[before..].to_vec();
    assert!(
        !new_entries.iter().any(|e| e.text.contains("hello")),
        "hide 规则未生效: {new_entries:?}"
    );
    assert!(new_entries.iter().any(|e| e.text.contains("visible")));

    // ── 断开 ──
    mgr.disconnect();
    assert!(!mgr.is_connected());
    assert!(rec.states.lock().unwrap().iter().any(|s| !s.connected));
}

/// 回归：冷启动时（未连接）就设置的过滤规则，connect 后必须生效。
/// 此前 set_filters 只发给活动线程的 cmd_tx，active=None 时被静默丢弃，
/// 手动开关一次才生效——本次必须自动生效（缓存配置在线程就绪后重放）。
#[test]
fn filters_set_before_connect_apply_after_connect() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());

    // 冷启动顺序：先设规则，后连接（此时还未建立会话线程）
    mgr.set_filters(vec![FilterRule {
        name: "hide-hello".into(),
        pattern: "hello".into(),
        action: "hide".into(),
        enabled: true,
    }]);

    mgr.connect(tcp_cfg(port)).expect("connect");

    // 回环回显：两行，一行命中 hide、一行可见
    mgr.send(&SendPayload {
        text: Some("hello world".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    mgr.send(&SendPayload {
        text: Some("keep visible".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();

    // 等可见行出现（证明管道活着且过滤已激活）
    assert!(
        wait_until(
            || rec
                .entries
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.text.contains("keep visible")),
            Duration::from_secs(3)
        ),
        "可见行未产出，连接前设置的过滤未生效"
    );

    // 命中 hide 的行绝不应被产出
    let entries = rec.entries.lock().unwrap();
    assert!(
        !entries.iter().any(|e| e.text.contains("hello")),
        "连接前设置的 hide 规则未生效: entries={:?}",
        *entries
    );
    mgr.disconnect();
}

#[test]
fn connect_rejects_bad_config_and_double_connect() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec);

    assert!(mgr
        .connect(ConnConfig::TcpClient {
            host: "".into(),
            port
        })
        .is_err());
    mgr.connect(tcp_cfg(port)).unwrap();
    // 单连接（ADR-0016）：重复连接拒绝
    assert!(mgr.connect(tcp_cfg(port)).is_err());
    mgr.disconnect();
}

#[test]
fn send_without_connection_errors() {
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec);
    let err = mgr.send(&SendPayload {
        text: Some("x".into()),
        hex: None,
        newline: "none".into(),
        echo: false,
    });
    assert!(err.is_err());
}

#[test]
fn plot_snapshot_shape_follows_format() {
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec);
    let snap = mgr.plot_snapshot(100);
    assert_eq!(snap.channel_count, 1); // 默认 1 通道
    mgr.set_plot_format(maxcom_core::plot::format::DataFormat::SimpleBinary {
        channel_count: 3,
        dtype: maxcom_core::plot::format::DType::F32,
        byte_order: maxcom_core::plot::format::ByteOrder::Little,
    });
    let snap = mgr.plot_snapshot(100);
    assert_eq!(snap.channel_count, 3);
    assert_eq!(snap.series.len(), 3);
}

/// ASCII 分包模式：整行 = 单通道样本序列，新行整通道覆盖（如 FFT 数组打印）
#[test]
fn plot_ascii_package_mode_overwrites_channel() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec);

    mgr.connect(tcp_cfg(port)).expect("connect");
    mgr.set_plot_format(maxcom_core::plot::format::DataFormat::AsciiDelimited {
        delimiter: ",".into(),
        filter_prefix: None,
        split: maxcom_core::plot::format::AsciiSplit::Package,
        channel_count: 0,
    });

    mgr.send(&SendPayload {
        text: Some("1,2,3\n4,5,6\n".into()),
        hex: None,
        newline: "none".into(),
        echo: false,
    })
    .expect("send");

    assert!(
        wait_until(
            || {
                let snap = mgr.plot_snapshot(1000);
                snap.channel_count == 1
                    && snap.series.first().map(|s| s.as_slice()) == Some(&[4.0, 5.0, 6.0][..])
            },
            Duration::from_secs(3)
        ),
        "分包模式应单通道且被新包覆盖 snap={:?}",
        mgr.plot_snapshot(1000)
    );
}

/// 回归：连接后再设绘图格式必须生效（此前热切换写入原字段、
/// 绘图线程读连接时的格式快照 → parser 永远是旧值，总点数恒 0）。
#[test]
fn plot_format_set_after_connect_parses_frames() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec);

    mgr.connect(tcp_cfg(port)).expect("connect");

    // 关键时序：先连接、后设格式（ASCII 自动列数）
    mgr.set_plot_format(maxcom_core::plot::format::DataFormat::AsciiDelimited {
        delimiter: ",".into(),
        filter_prefix: None,
        split: Default::default(),
        channel_count: 0,
    });

    // 发送两行两列数据，回环返回后应被解析入库（自动探测 → 2 通道）
    mgr.send(&SendPayload {
        text: Some("123456,123456\n123456,123456\n".into()),
        hex: None,
        newline: "none".into(),
        echo: false,
    })
    .expect("send");

    assert!(
        wait_until(
            || mgr.plot_snapshot(1000).total_points >= 2,
            Duration::from_secs(3)
        ),
        "热切换后绘图仍无数据 total_points={}",
        mgr.plot_snapshot(1000).total_points
    );
    let snap = mgr.plot_snapshot(1000);
    assert_eq!(snap.channel_count, 2, "ASCII 自动通道应锁定为 2 列");
}

// ── 自动重连 / 捕获 ──

/// 每个连接只回显一条消息就断开（触发客户端 EOF），但持续接受新连接
fn spawn_drop_after_echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut s = stream;
            let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
            let mut buf = [0u8; 512];
            if let Ok(n @ 1..) = s.read(&mut buf) {
                let _ = s.write_all(&buf[..n]);
            }
            drop(s); // 主动断开 → 客户端读到 EOF
        }
    });
    port
}

#[test]
fn auto_reconnect_restores_link() {
    let port = spawn_drop_after_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_reconnect_delay_ms(100);

    mgr.connect(tcp_cfg(port)).unwrap();
    let connected_count = |rec: &Recorder| {
        rec.states
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.connected)
            .count()
    };
    // 第一条：回显成功后服务端断开
    mgr.send(&SendPayload {
        text: Some("ping-1".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    assert!(
        wait_until(
            || rec.raw.lock().unwrap().windows(6).any(|w| w == b"ping-1"),
            Duration::from_secs(3)
        ),
        "第一次回显未到达"
    );
    assert!(
        wait_until(|| connected_count(&rec) >= 2, Duration::from_secs(5)),
        "自动重连未发生，states={:?}",
        rec.states.lock().unwrap()
    );
    // 重连后链路可用
    mgr.send(&SendPayload {
        text: Some("ping-2".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    assert!(
        wait_until(
            || rec.raw.lock().unwrap().windows(6).any(|w| w == b"ping-2"),
            Duration::from_secs(3)
        ),
        "重连后发送未到达"
    );
    mgr.disconnect();
}

#[test]
fn no_reconnect_when_disabled() {
    let port = spawn_drop_after_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_auto_reconnect(false);
    mgr.connect(tcp_cfg(port)).unwrap();

    mgr.send(&SendPayload {
        text: Some("bye".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    assert!(
        wait_until(
            || rec.states.lock().unwrap().iter().any(|s| !s.connected),
            Duration::from_secs(3)
        ),
        "掉线事件未上报"
    );
    std::thread::sleep(Duration::from_millis(400));
    let reconnected = rec
        .states
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.connected)
        .count();
    assert_eq!(reconnected, 1, "关闭重连后不应再连");
    // 注：不在此断言 send 必失败——TCP 写在对端 RST 到达前可能仍入缓冲成功（非确定性）
}

#[test]
fn capture_roundtrip_to_file() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec);
    mgr.connect(tcp_cfg(port)).unwrap();

    mgr.start_capture();
    mgr.send(&SendPayload {
        text: Some("capture-me".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    assert!(
        wait_until(|| mgr.capture_state().1 >= 11, Duration::from_secs(3)),
        "捕获缓冲未收到数据 state={:?}",
        mgr.capture_state()
    );

    let path = std::env::temp_dir().join("maxcom_capture_test.bin");
    let n = mgr.save_capture(path.to_str().unwrap()).expect("save");
    assert_eq!(n, 11);
    let saved = std::fs::read(&path).unwrap();
    assert_eq!(saved, b"capture-me\n");
    let _ = std::fs::remove_file(&path);
    mgr.disconnect();
}

#[test]
fn capture_streams_large_payload_beyond_chunk() {
    // 大载荷（远超 CAP_CHUNK）经多次 flush 落盘，且不再有 64MiB 内存上限。
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec);
    mgr.connect(tcp_cfg(port)).unwrap();

    mgr.start_capture();
    let big = "x".repeat(200_000);
    mgr.send(&SendPayload {
        text: Some(big.clone()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    let expected = big.len() as u64 + 1;
    assert!(
        wait_until(|| mgr.capture_state().1 >= expected, Duration::from_secs(5)),
        "大载荷捕获未完整 state={:?}",
        mgr.capture_state()
    );

    let path = std::env::temp_dir().join("maxcom_capture_big.bin");
    let n = mgr.save_capture(path.to_str().unwrap()).expect("save");
    assert_eq!(n, expected);
    let saved = std::fs::read(&path).unwrap();
    assert_eq!(saved.len(), expected as usize);
    assert_eq!(&saved[..expected as usize - 1], big.as_bytes());
    assert_eq!(saved[expected as usize - 1], b'\n');
    let _ = std::fs::remove_file(&path);
    mgr.disconnect();
}

#[test]
fn capture_cancel_discards_temp_and_stops() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec);
    mgr.connect(tcp_cfg(port)).unwrap();

    mgr.start_capture();
    assert!(mgr.capture_state().0);
    mgr.send(&SendPayload {
        text: Some("x".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    assert!(
        wait_until(|| mgr.capture_state().1 >= 2, Duration::from_secs(3)),
        "未收到捕获数据 state={:?}",
        mgr.capture_state()
    );

    mgr.cancel_capture();
    assert!(!mgr.capture_state().0, "cancel 后不应再捕获中");
    assert_eq!(mgr.capture_state().1, 0, "cancel 后已捕获字节应清零");
    assert!(
        mgr.save_capture("should_fail.bin").is_err(),
        "cancel 后再 save 应报未在捕获中"
    );
    mgr.disconnect();
}

#[test]
fn line_split_idle_flush_marks_partial() {
    // 换行分包：无结尾换行的残余（shell 提示符/最后一行）在空闲封行时刷出为
    // partial=true 的未结束部分行——前端据此续接到当前行，不把提示符与后续命令拆成两行。
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_log_options(LogOptions {
        idle_timeout_ms: 10,
        timestamp_mode: TimestampMode::Absolute,
        encoding: "auto".into(),
        split_mode: "line".into(),
    });
    mgr.connect(tcp_cfg(port)).expect("connect");
    assert!(mgr.is_connected());

    // 发送无换行的 "prompt"：回显到达后无更多数据 → 空闲封行应把它作为部分行刷出
    mgr.send(&SendPayload {
        text: Some("prompt".into()),
        hex: None,
        newline: "none".into(),
        echo: false,
    })
    .unwrap();

    assert!(
        wait_until(
            || rec
                .entries
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.partial && e.text.contains("prompt")),
            Duration::from_secs(3)
        ),
        "换行分包：空闲封行应把无换行残余刷为 partial=true（未结束部分行）"
    );
    mgr.disconnect();
}

#[test]
fn timeout_mode_chunks_whole_burst_as_single_entry() {
    // 超时分包：应对无换行协议——不按换行拆行，整段累积、空闲封行输出为一个时间块（partial=false 独立一行）。
    // 与换行分包（逐行拆、每行一条）必须区分开，不能"换行=超时行为一致"。
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_log_options(LogOptions {
        idle_timeout_ms: 10,
        timestamp_mode: TimestampMode::Absolute,
        encoding: "auto".into(),
        split_mode: "timeout".into(),
    });
    mgr.connect(tcp_cfg(port)).expect("connect");
    assert!(mgr.is_connected());

    // 发送一段带换行的突发：超时分包应整段一条（含 a、b、c 的完整时间块），而非逐行三条。
    mgr.send(&SendPayload {
        text: Some("a\r\nb\r\nc".into()),
        hex: None,
        newline: "none".into(),
        echo: false,
    })
    .unwrap();

    assert!(
        wait_until(
            || rec
                .entries
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.text.contains("a") && e.text.contains("c") && !e.partial),
            Duration::from_secs(3)
        ),
        "超时分包应把整段突发输出为一条时间块（含 a/c），而不是逐行拆"
    );
    // 不应出现把 b 单独拆成一条的情况（整段时间块只一条含 b）
    let b_entries = rec
        .entries
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.text.contains("b"))
        .count();
    assert!(
        b_entries <= 1,
        "超时分包不应逐行拆（含 b 的条数={}）",
        b_entries
    );

    mgr.disconnect();
}

/// 长流防护回归：发送 total 字节无换行数据（'A' 填充），断言分批产出 ≤PARTIAL_FLUSH_CAP
/// 的 entry 且字节完整。旧行为：无换行+无空闲 → batch 恒空前端收不到数据，结束后才一次性
/// 刷出一条 total 字节的巨行（前端渲染卡死）。
fn assert_lf_free_stream_streams(rec: &Arc<Recorder>, mgr: &SessionManager, total: usize) {
    let hex: String = "41".repeat(total);
    let n = mgr
        .send(&SendPayload {
            text: None,
            hex: Some(hex),
            newline: "none".into(),
            echo: false,
        })
        .expect("send");
    assert_eq!(n, total);

    assert!(
        wait_until(
            || {
                rec.entries
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|e| e.text.len())
                    .sum::<usize>()
                    >= total
            },
            Duration::from_secs(5)
        ),
        "无换行长流未持续产出 entries（长流防护失效）"
    );

    let entries = rec.entries.lock().unwrap().clone();
    let total_len: usize = entries.iter().map(|e| e.text.len()).sum();
    assert_eq!(total_len, total, "长流字节数不完整");
    let max_len = entries.iter().map(|e| e.text.len()).max().unwrap_or(0);
    assert!(
        max_len <= 4096,
        "存在超过 4096B 的巨型 entry（len={max_len}）——未按块封行，前端会一次性渲染巨行"
    );
    assert!(
        entries.len() >= 2,
        "应分批产出多条 entry，实际 {} 条",
        entries.len()
    );
}

#[test]
fn long_lf_free_stream_streams_entries_line_mode() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.connect(tcp_cfg(port)).expect("connect");
    assert_lf_free_stream_streams(&rec, &mgr, 20_000);
    mgr.disconnect();
}

#[test]
fn long_lf_free_stream_streams_entries_timeout_mode() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_log_options(LogOptions {
        idle_timeout_ms: 10,
        timestamp_mode: TimestampMode::Absolute,
        encoding: "auto".into(),
        split_mode: "timeout".into(),
    });
    mgr.connect(tcp_cfg(port)).expect("connect");
    assert_lf_free_stream_streams(&rec, &mgr, 20_000);
    mgr.disconnect();
}

/// 静止服务器：接受连接并持续读取，但从不回复（模拟"设备不回显"）。
fn spawn_sink_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut s = stream;
            let _ = s.set_read_timeout(Some(Duration::from_millis(50)));
            let mut buf = [0u8; 1024];
            loop {
                match s.read(&mut buf) {
                    Ok(0) => break,                                          // 对端关闭
                    Ok(_) => {}                                              // 只读不回
                    Err(_) => std::thread::sleep(Duration::from_millis(10)), // 读超时：连接保持
                }
            }
        }
    });
    port
}

/// 本地回显：设备不回显时也能在收发区看到自己发了什么。
/// 由 SendPayload.echo 按次决定——取 false 时不产出日志行；取 true 时产出，
/// 且只进 "log" 订阅者（不污染终端/绘图的原始流）。
#[test]
fn local_echo_shows_sent_text_when_device_silent() {
    let port = spawn_sink_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.connect(tcp_cfg(port)).expect("connect");

    let payload = |text: &str, echo: bool| SendPayload {
        text: Some(text.into()),
        hex: None,
        newline: "\n".into(),
        echo,
    };

    // ── echo=false：内容照常发出，但不进收发区 ──
    mgr.send(&payload("PING", false)).expect("send");
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !rec.entries
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.text.contains("PING")),
        "echo=false 时不应产出日志行"
    );
    assert_eq!(mgr.stats().tx_bytes, 5, "字节应照常写出");

    // ── echo=true：同一路径应产出日志行，且必须标成发送方向 ──
    mgr.send(&payload("ECHO", true)).expect("send");
    assert!(
        wait_until(
            || rec
                .entries
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.text.contains("ECHO")),
            Duration::from_secs(3)
        ),
        "echo=true 时应产出日志行"
    );
    let echoed = rec
        .entries
        .lock()
        .unwrap()
        .iter()
        .find(|e| e.text.contains("ECHO"))
        .cloned()
        .expect("回显行");
    assert_eq!(
        echoed.dir,
        IoDir::Tx,
        "本地回显行必须标成发送（否则界面无法与设备回显区分）"
    );
    assert!(
        rec.raw.lock().unwrap().is_empty(),
        "本地回显只进日志管线，不应进入原始流（终端/绘图）"
    );
    assert_eq!(mgr.stats().tx_bytes, 10, "响应回来后 TX 也不受影响");

    mgr.disconnect();
}

/// 方向标签的两个来源必须都保真：设备回读的行（RX）与本机本地回显的行（TX）内容可以完全
/// 相同，差别只在 `dir` —— 这正是界面「时间戳后标 ←/→」赖以成立的全部依据。
/// 回归点：只按"谁先来/内容像不像"猜方向，或整个批次共用一个方向，都会在这里挂掉。
#[test]
fn log_entry_direction_distinguishes_rx_from_local_echo() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.connect(tcp_cfg(port)).expect("connect");

    // 同一个字符串走两条路：设备回读（RX）+ 本机回显（TX）
    mgr.send(&SendPayload {
        text: Some("SAME".into()),
        hex: None,
        newline: "\n".into(),
        echo: true,
    })
    .expect("send");

    assert!(
        wait_until(
            || {
                let es = rec.entries.lock().unwrap();
                es.iter()
                    .any(|e| e.dir == IoDir::Rx && e.text.contains("SAME"))
                    && es
                        .iter()
                        .any(|e| e.dir == IoDir::Tx && e.text.contains("SAME"))
            },
            Duration::from_secs(3)
        ),
        "同一内容的回读行(→rx)与回显行(→tx)必须各自出现，实际={:?}",
        rec.entries
            .lock()
            .unwrap()
            .iter()
            .map(|e| (e.dir, e.text.clone()))
            .collect::<Vec<_>>()
    );

    // 关闭回显后不得再产出 tx 行（设备的回读仍是 rx）
    let before = rec.entries.lock().unwrap().len();
    mgr.send(&SendPayload {
        text: Some("ONLY_RX".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .expect("send");
    assert!(
        wait_until(
            || rec
                .entries
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.text.contains("ONLY_RX")),
            Duration::from_secs(3)
        ),
        "设备回读应产出日志行"
    );
    assert!(
        rec.entries
            .lock()
            .unwrap()
            .iter()
            .skip(before)
            .all(|e| e.dir == IoDir::Rx),
        "echo=false 时不应有任何发送方向的行"
    );

    mgr.disconnect();
}

// ── 连接阶段状态机（ADR-0020：可取消连接 / 重连阶段上报）──

/// `begin_connect` 必须**同步广播 connecting、立即返回**，建立过程在后台线程完成。
/// 回归：旧 `connect()` 是同步阻塞命令（串口 open / SSH 握手最坏 20s），Tauri 主线程
/// 被占死 → 界面卡死，且用户无法取消。
#[test]
fn begin_connect_returns_immediately_and_broadcasts_connecting_first() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = Arc::new(SessionManager::new(rec.clone()));

    let t0 = Instant::now();
    mgr.begin_connect(tcp_cfg(port)).expect("begin_connect");
    let elapsed = t0.elapsed();
    assert!(
        elapsed < Duration::from_millis(500),
        "begin_connect 阻塞了 {elapsed:?}（应只做登记 + 广播后立即返回）"
    );

    // connecting 必须是第一条状态事件（open 还在后台线程里跑）——
    // 这是「按钮立刻切成取消 + 转圈」的依据。
    {
        let states = rec.states.lock().unwrap();
        let first = states.first().expect("应广播 connecting");
        assert_eq!(first.phase, ConnPhase::Connecting, "首事件应为 connecting");
        assert!(!first.connected);
    }

    assert!(
        wait_until(|| mgr.is_connected(), Duration::from_secs(3)),
        "后台 open 未完成"
    );
    assert!(
        wait_until(
            || rec
                .states
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.phase == ConnPhase::Connected && s.connected),
            Duration::from_secs(3)
        ),
        "未广播 connected"
    );
    assert_eq!(mgr.conn_state().phase, ConnPhase::Connected);

    // 单连接（ADR-0016）：已连接时再 begin 必须同步拒绝
    assert!(
        mgr.begin_connect(tcp_cfg(port)).is_err(),
        "已有活动连接时应拒绝"
    );
    mgr.disconnect();
}

/// 取消连接：立即返回、广播 cancelled，且迟到的成功结果被丢弃。
///
/// 用 RFC 5737 保留网段 `192.0.2.1`（不可路由）让 `open()` 停在连接超时里，
/// 使「取消发生在连接建立过程中」这一时序确实被覆盖；若运行环境秒拒（无路由 / RST），
/// 则退化为「尝试已结束」分支断言——两种环境都不得卡在 connecting。
#[test]
fn cancel_connect_aborts_pending_attempt() {
    let rec = Arc::new(Recorder::default());
    let mgr = Arc::new(SessionManager::new(rec.clone()));

    let t0 = Instant::now();
    mgr.begin_connect(ConnConfig::TcpClient {
        host: "192.0.2.1".into(),
        port: 9,
    })
    .expect("begin_connect");
    assert!(
        t0.elapsed() < Duration::from_millis(500),
        "begin_connect 不应等待建立过程"
    );

    if mgr.cancel_connect() {
        // 取消后：状态必须落到 cancelled，且**不得**出现连接成功
        assert!(!mgr.cancel_connect(), "重复取消应为 no-op");
        std::thread::sleep(Duration::from_millis(300));
        let states = rec.states.lock().unwrap();
        assert!(
            states.iter().any(|s| s.phase == ConnPhase::Cancelled),
            "取消未广播 cancelled: {states:?}"
        );
        assert!(
            !states.iter().any(|s| s.connected),
            "取消后迟到的成功结果应被丢弃: {states:?}"
        );
        drop(states);
        assert!(!mgr.is_connected(), "取消后不应残留会话");
    } else {
        // 环境秒拒：尝试已自行结束，只允许是失败 / 取消态，不能卡在 connecting
        let p = mgr.conn_state().phase;
        assert!(
            matches!(
                p,
                ConnPhase::Failed | ConnPhase::Cancelled | ConnPhase::Disconnected
            ),
            "尝试结束后阶段异常: {p:?}"
        );
    }
    mgr.disconnect();
}

/// 空转取消是 no-op：不应凭空广播状态（避免前端被假 cancelled 事件打断）。
#[test]
fn cancel_connect_without_attempt_is_noop() {
    let rec = Arc::new(Recorder::default());
    let mgr = Arc::new(SessionManager::new(rec.clone()));
    assert!(!mgr.cancel_connect());
    assert!(!mgr.cancel_connect());
    assert!(
        rec.states.lock().unwrap().is_empty(),
        "无进行中尝试时不应广播状态"
    );
}

/// 自动重连必须**上报阶段**（reconnecting + 尝试次数），而不是静默重试：
/// 前端据此显示「自动重连中（第 n 次）」并允许用户中止。
#[test]
fn reconnect_reports_phase_and_attempt() {
    let port = spawn_drop_after_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_reconnect_delay_ms(100);
    mgr.connect(tcp_cfg(port)).unwrap();

    mgr.send(&SendPayload {
        text: Some("ping".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();

    assert!(
        wait_until(
            || rec
                .states
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.phase == ConnPhase::Reconnecting && s.attempt >= 1 && !s.connected),
            Duration::from_secs(5)
        ),
        "未广播 reconnecting: {:?}",
        rec.states.lock().unwrap()
    );
    assert!(
        wait_until(
            || mgr.conn_state().phase == ConnPhase::Connected,
            Duration::from_secs(5)
        ),
        "重连未恢复"
    );
    assert!(
        rec.states
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.phase == ConnPhase::Connected && s.attempt == 0),
        "重连成功后 attempt 应归零"
    );
    mgr.disconnect();
}

/// 掉线 + 关闭自动重连 → 会话自行终结并被回收：不留后台残留连接。
///
/// 回归（用户实测）：拔串口后「顶栏已变红点、右侧仍显示连接」，且用户不希望重连时
/// 只能再点一次「连接」触发报错才能复位。现在会话终结即回收 active，
/// 连接/断开前无需再靠「点一下报错」解锁。
#[test]
fn dropped_link_without_reconnect_reaps_session() {
    let port = spawn_drop_after_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_auto_reconnect(false);
    mgr.connect(tcp_cfg(port)).unwrap();

    mgr.send(&SendPayload {
        text: Some("bye".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();

    assert!(
        wait_until(
            || rec.states.lock().unwrap().iter().any(|s| {
                !s.connected && matches!(s.phase, ConnPhase::Failed | ConnPhase::Disconnected)
            }),
            Duration::from_secs(3)
        ),
        "掉线未上报终态: {:?}",
        rec.states.lock().unwrap()
    );
    assert!(
        wait_until(|| !mgr.is_connected(), Duration::from_secs(3)),
        "掉线后 active 残留（会误报「已有活动连接」）"
    );
    assert_eq!(mgr.conn_state().phase, ConnPhase::Disconnected);

    // 单连接锁已释放：插回设备后可直接连接，无需先点一次「连接」看报错
    let port2 = spawn_echo_server();
    mgr.connect(tcp_cfg(port2)).expect("掉线后应能立即重连");
    mgr.disconnect();
}

// ── 最近 I/O 环形缓冲（MCP `read_io` 的数据来源）──

/// 锁「接线」而非环本身（环的丢旧/切分/续读在 session.rs 单测里覆盖）：
/// 读线程收到字节必须入环、`send` 写出的字节也必须入环，且能按 seq 不重不漏地续读。
///
/// 为什么值得单独测：`io_since` 是 MCP 侧「发命令 → 读响应」闭环的唯一数据源，
/// 埋点一旦从读线程漏掉（或只埋了 RX 没埋 TX），AI 就会看到空的会话历史却毫无报错。
#[test]
fn io_since_captures_rx_and_tx_in_order() {
    let port = spawn_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec);

    mgr.connect(tcp_cfg(port)).expect("connect");
    mgr.clear_io(); // 干净起点（connect 前若有杂数据不影响断言）
    assert!(mgr.io_since(0, usize::MAX).0.is_empty());

    let n = mgr
        .send(&SendPayload {
            text: Some("AT".into()),
            hex: None,
            newline: "none".into(),
            echo: false,
        })
        .expect("send");
    assert_eq!(n, 2);

    let rx_len = |mgr: &SessionManager| -> usize {
        mgr.io_since(0, usize::MAX)
            .0
            .iter()
            .filter(|c| c.dir == IoDir::Rx)
            .map(|c| c.data.len())
            .sum()
    };
    assert!(
        wait_until(|| rx_len(&mgr) >= 2, Duration::from_secs(3)),
        "接收字节未入环（读线程埋点缺失？）"
    );

    let (chunks, max_seq, oldest) = mgr.io_since(0, usize::MAX);
    let collect = |dir: IoDir| -> Vec<u8> {
        chunks
            .iter()
            .filter(|c| c.dir == dir)
            .flat_map(|c| c.data.clone())
            .collect()
    };
    assert_eq!(collect(IoDir::Tx), b"AT", "发送字节未入环或内容错");
    assert_eq!(collect(IoDir::Rx), b"AT", "回显字节不完整");

    // TCP 回环可能把一个报文拆/并成多块，故只断言「方向内最早 seq」的先后
    let tx_min = chunks
        .iter()
        .filter(|c| c.dir == IoDir::Tx)
        .map(|c| c.seq)
        .min()
        .unwrap();
    let rx_min = chunks
        .iter()
        .filter(|c| c.dir == IoDir::Rx)
        .map(|c| c.seq)
        .min()
        .unwrap();
    assert!(tx_min < rx_min, "发送记录应早于回显到达");

    // 续读语义：seq 严格递增、端点与环上报的 oldest/max 一致、读完无新块
    assert!(chunks.windows(2).all(|w| w[0].seq < w[1].seq));
    assert_eq!(chunks.first().unwrap().seq, oldest);
    assert_eq!(chunks.last().unwrap().seq, max_seq);
    assert!(
        mgr.io_since(max_seq, usize::MAX).0.is_empty(),
        "按 max_seq 续读应无新块"
    );

    // 清空只影响环，不影响链路：之后仍能收发并重新记账
    mgr.clear_io();
    assert!(mgr.io_since(0, usize::MAX).0.is_empty());
    assert!(mgr.is_connected(), "clear_io 不应影响连接");
    mgr.disconnect();
}

// ── 链路类型上报（顶栏「连接类型」下拉回填用）──

/// `ConnState.kind` 必须在**建立成功**与**自动重连中**都带上真实传输类型。
///
/// 用途是顶栏下拉回填：连接可能由 MCP/AI 侧发起，此时下拉里还停着用户上次的选择，
/// 会整块显示成另一种传输（用户实测场景：AI 连的是串口，表单显示 TCP）。
/// 断开态则刻意**不带** kind —— 让用户自己的选择留在表单里，便于原样重连。
#[test]
fn conn_state_reports_link_kind_on_connect_and_reconnect() {
    let port = spawn_drop_after_echo_server();
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_reconnect_delay_ms(100);

    assert_eq!(mgr.conn_state().kind, None, "断开态不应带 kind");

    mgr.connect(tcp_cfg(port)).expect("connect");
    assert_eq!(
        mgr.conn_state().kind.as_deref(),
        Some("tcp_client"),
        "连接建立后 conn_state 必须带真实类型"
    );

    // 事件路径同样带 kind：前端靠事件驱动，不是轮询
    let has_kind_event = |phase: ConnPhase| {
        rec.states
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.phase == phase && s.kind.as_deref() == Some("tcp_client"))
    };
    assert!(
        wait_until(
            || has_kind_event(ConnPhase::Connected),
            Duration::from_secs(3)
        ),
        "connected 事件未带 kind: {:?}",
        rec.states.lock().unwrap()
    );

    // 触发掉线 → 自动重连中也要带 kind（链路断了，但目标类型是确定的）
    mgr.send(&SendPayload {
        text: Some("ping".into()),
        hex: None,
        newline: "\n".into(),
        echo: false,
    })
    .unwrap();
    assert!(
        wait_until(
            || has_kind_event(ConnPhase::Reconnecting),
            Duration::from_secs(5)
        ),
        "reconnecting 事件未带 kind: {:?}",
        rec.states.lock().unwrap()
    );

    mgr.disconnect();
    assert_eq!(mgr.conn_state().kind, None, "断开后回到无类型");
}

// ── 混合编码流：UTF-8 行不得被整行误解码 ──

/// 按脚本逐段推送字节的服务器（模拟设备分段发送）。
fn spawn_scripted_server(script: Vec<Vec<u8>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut s = stream;
            let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
            for chunk in script.iter() {
                if s.write_all(chunk).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            // 保持连接，直到对端关闭
            let mut buf = [0u8; 1024];
            while let Ok(n) = s.read(&mut buf) {
                if n == 0 {
                    break;
                }
            }
        }
    });
    port
}

/// 回归（用户实测「中英混合又出问题了」）：设备用 **UTF-8** 输出中英混排日志，
/// 且行尾切点落在汉字中间时，后续整行中文**不得**变成「寰呮満涓婃姤」这类乱码。
///
/// 机理（旧行为）：残缺尾字节被喂进编码检测窗口 → 窗口误锁 GBK →
/// 之后每一行合法 UTF-8 都被按 GBK 解码。
#[test]
fn mixed_utf8_stream_stays_readable_after_truncated_tail() {
    let cn = "cmd=40(待机上报) len=11 ret=0 host=55DF4EAB ch=3";
    // 第一段：正常整行（合法 UTF-8，带换行）
    let mut first = cn.as_bytes().to_vec();
    first.push(b'\n');
    // 第二段：整行末尾切在「状」字中间（只剩 2 字节），设备稍后再补齐
    let mut truncated = cn.as_bytes().to_vec();
    truncated.extend_from_slice(&[0xe7, 0x8a]); // 「状」的 UTF-8 前 2 字节（E7 8A B6）
                                                // 第三段：补齐剩余字节 + 换行 → 完整行
    let mut tail = vec![0xb6]; // 「状」的末字节
    tail.push(b'\n');
    // 第四段：再来一行完整的合法 UTF-8（此时窗口可能已被毒化）
    let mut last = "cmd=40(运行态上报) len=11 ret=0 host=55DF4EAB ch=3"
        .as_bytes()
        .to_vec();
    last.push(b'\n');

    let port = spawn_scripted_server(vec![first, truncated, tail, last]);
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_log_options(LogOptions {
        idle_timeout_ms: 10,
        timestamp_mode: TimestampMode::Absolute,
        encoding: "auto".into(),
        split_mode: "line".into(),
    });
    mgr.connect(tcp_cfg(port)).expect("connect");

    assert!(
        wait_until(
            || rec
                .entries
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.text.contains("运行态上报")),
            Duration::from_secs(5)
        ),
        "未收到最后一行: {:?}",
        rec.entries
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.text.clone())
            .collect::<Vec<_>>()
    );

    let texts: Vec<String> = rec
        .entries
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.text.clone())
        .collect();
    for t in &texts {
        assert!(
            !t.contains("寰呮満涓婃姤") && !t.contains("杩愯"),
            "整行被误解码为乱码: {t}"
        );
    }
    assert!(
        texts.iter().any(|t| t.contains("待机上报")),
        "「待机上报」应原样显示，实际: {texts:?}"
    );
    assert!(
        texts.iter().any(|t| t.contains("运行态上报")),
        "「运行态上报」应原样显示，实际: {texts:?}"
    );
    mgr.disconnect();
}

// ── 中英混合流：GBK 行与 UTF-8 行交错，读块边界切在汉字中间 ──

/// 回归（用户实测「中英混合又出问题了」）：设备先发 GBK 行、再发 UTF-8 行，
/// 且**两次的读块边界都切在汉字中间**。
///
/// 旧行为的两个失效点：
/// 1. 残缺尾字节被喂进编码检测窗口 → 窗口误锁 GBK → 之后的 UTF-8 行整体乱码
///    （「待机上报」→「寰呮満涓婃姤」）；
/// 2. 切点由调用方计算，与解码用的编码不一致 → 「按 A 解、按 B 切」→ 整行错位。
///
/// 流式方案下这两点都从结构上消失：解码器自己持有半个字符，
/// 且检测窗口永远看不到半个字符。
#[test]
fn mixed_gbk_then_utf8_lines_survive_mid_character_cuts() {
    // GBK 行（设备老固件）
    let gbk_line = "状态=0 已录=100/100 间隔=1s";
    let mut gbk_bytes = maxcom_core::encoding::encode(gbk_line, "gbk").0;
    gbk_bytes.push(b'\n');
    // UTF-8 行（新固件）
    let utf8_line = "cmd=40(待机上报) len=11 ret=0 host=55DF4EAB ch=3";
    let mut utf8_bytes = utf8_line.as_bytes().to_vec();
    utf8_bytes.push(b'\n');

    // 在 GBK 汉字中间切一刀（首字节之后）
    let gbk_cut = 1 + 1; // "状态" 的首字节在 index 0 → 切在 index 1
    assert!(
        gbk_bytes[0] >= 0x81 && gbk_bytes[0] <= 0xFE,
        "应为 GBK 首字节"
    );

    // 在 UTF-8 汉字中间切一刀（3 字节字符的第 1 字节之后）
    let u_start = utf8_line.find("待").unwrap();
    let utf8_cut = u_start + 1;

    let script: Vec<Vec<u8>> = vec![
        gbk_bytes[..gbk_cut].to_vec(),
        gbk_bytes[gbk_cut..].to_vec(),
        utf8_bytes[..utf8_cut].to_vec(),
        utf8_bytes[utf8_cut..].to_vec(),
    ];

    let port = spawn_scripted_server(script);
    let rec = Arc::new(Recorder::default());
    let mgr = SessionManager::new(rec.clone());
    mgr.set_log_options(LogOptions {
        idle_timeout_ms: 10,
        timestamp_mode: TimestampMode::Absolute,
        encoding: "auto".into(),
        split_mode: "line".into(),
    });
    mgr.connect(tcp_cfg(port)).expect("connect");

    let joined = |rec: &Arc<Recorder>| -> String {
        rec.entries
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.text.clone())
            .collect::<Vec<_>>()
            .join("\n")
    };

    assert!(
        wait_until(
            || {
                let t = joined(&rec);
                t.contains("待机上报") && t.contains("状态=0")
            },
            Duration::from_secs(5)
        ),
        "两行都应到达: {:?}",
        joined(&rec)
    );

    let text = joined(&rec);
    assert!(text.contains("状态=0"), "GBK 行必须正确显示: {text:?}");
    assert!(text.contains("待机上报"), "UTF-8 行必须正确显示: {text:?}");
    assert!(
        !text.contains("寰呮満涓婃姤"),
        "UTF-8 行不得被误解码: {text:?}"
    );
    mgr.disconnect();
}
