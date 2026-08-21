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
