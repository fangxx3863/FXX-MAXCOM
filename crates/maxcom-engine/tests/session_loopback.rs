//! 会话编排集成测试：TCP 回环验证 读→扇出→日志引擎→回调 / 发送 / 统计 / 过滤 全链路。

use maxcom_core::filter::FilterRule;
use maxcom_engine::session::{ConnState, LogEntryDto, SendPayload, SessionEvents, SessionManager};
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
    })
    .unwrap();
    mgr.send(&SendPayload {
        text: Some("visible".into()),
        hex: None,
        newline: "\n".into(),
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
