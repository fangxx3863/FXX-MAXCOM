//! 统计追踪（P4 统计页数据源）。
//!
//! 累计 RX/TX 字节 + 滑动窗口实时速率（2 秒窗）；错误帧计数。
//! 时间源可注入（测试传合成时钟），默认单调钟。

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Instant;

/// 速率滑动窗口（秒）
pub const RATE_WINDOW_S: f64 = 2.0;

/// 统计快照 DTO（前端轮询渲染）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StatsSnapshot {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_rate_kbs: f64,
    pub tx_rate_kbs: f64,
    pub crc_errors: u64,
    pub frame_errors: u64,
}

struct Inner {
    rx_total: u64,
    tx_total: u64,
    rx_window: VecDeque<(f64, u64)>,
    tx_window: VecDeque<(f64, u64)>,
    crc_errors: u64,
    frame_errors: u64,
}

/// 线程安全的统计器。`now` 返回单调秒。
pub struct StatsTracker {
    inner: Mutex<Inner>,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
}

impl Default for StatsTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl StatsTracker {
    /// 默认时钟：单调钟（进程内相对秒，不依赖系统墙钟）。
    pub fn new() -> Self {
        let start = Instant::now();
        Self::with_clock(Box::new(move || start.elapsed().as_secs_f64()))
    }

    pub fn with_clock(now: Box<dyn Fn() -> f64 + Send + Sync>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                rx_total: 0,
                tx_total: 0,
                rx_window: VecDeque::new(),
                tx_window: VecDeque::new(),
                crc_errors: 0,
                frame_errors: 0,
            }),
            now,
        }
    }

    pub fn record_rx(&self, n: usize) {
        self.record("rx", n as u64);
    }

    pub fn record_tx(&self, n: usize) {
        self.record("tx", n as u64);
    }

    fn record(&self, dir: &str, n: u64) {
        let now = (self.now)();
        let mut g = self.inner.lock().unwrap();
        match dir {
            "rx" => {
                g.rx_total += n;
                g.rx_window.push_back((now, n));
            }
            _ => {
                g.tx_total += n;
                g.tx_window.push_back((now, n));
            }
        }
        sweep(&mut g.rx_window, now);
        sweep(&mut g.tx_window, now);
    }

    pub fn record_crc_error(&self) {
        self.inner.lock().unwrap().crc_errors += 1;
    }

    pub fn record_frame_error(&self) {
        self.inner.lock().unwrap().frame_errors += 1;
    }

    pub fn rx_bytes(&self) -> u64 {
        self.inner.lock().unwrap().rx_total
    }

    pub fn tx_bytes(&self) -> u64 {
        self.inner.lock().unwrap().tx_total
    }

    /// 快照：单次加锁内完成窗口清扫与速率计算（不可重入锁，严禁嵌套）。
    pub fn snapshot(&self) -> StatsSnapshot {
        let now = (self.now)();
        let mut g = self.inner.lock().unwrap();
        sweep(&mut g.rx_window, now);
        sweep(&mut g.tx_window, now);
        StatsSnapshot {
            rx_bytes: g.rx_total,
            tx_bytes: g.tx_total,
            rx_rate_kbs: window_rate(&g.rx_window, now),
            tx_rate_kbs: window_rate(&g.tx_window, now),
            crc_errors: g.crc_errors,
            frame_errors: g.frame_errors,
        }
    }
}

/// 窗口速率 KB/s（无锁纯函数；调用方持有互斥体）
fn window_rate(window: &VecDeque<(f64, u64)>, now: f64) -> f64 {
    if window.is_empty() {
        return 0.0;
    }
    let total: u64 = window.iter().map(|(_, n)| n).sum();
    let span = (now - window.front().unwrap().0).max(1e-6);
    (total as f64 / span) / 1024.0
}

fn sweep(window: &mut VecDeque<(f64, u64)>, now: f64) {
    let cutoff = now - RATE_WINDOW_S;
    while window.front().is_some_and(|&(t, _)| t < cutoff) {
        window.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_accumulate() {
        let t = StatsTracker::new();
        t.record_rx(100);
        t.record_tx(50);
        assert_eq!(t.rx_bytes(), 100);
        assert_eq!(t.tx_bytes(), 50);
    }

    #[test]
    #[allow(unused_assignments)] // t 通过闭包被时钟读取，编译器静态分析误报
    fn sliding_window_rate_with_injected_clock() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let t = std::sync::Arc::new(AtomicU64::new(0.0f64.to_bits()));
        let tc = t.clone();
        let tracker =
            StatsTracker::with_clock(Box::new(move || f64::from_bits(tc.load(Ordering::Relaxed))));
        let set_t = |v: f64| t.store(v.to_bits(), Ordering::Relaxed);
        tracker.record_rx(1024); // t=0：1 KB
        set_t(1.0);
        tracker.record_rx(1024); // t=1：再 1 KB
                                 // 窗口 [max(t-2,·),t]=[0,1]，span=1s，total=2048 → 2 KB/s
        let s = tracker.snapshot();
        assert!((s.rx_rate_kbs - 2.0).abs() < 1e-6, "got {}", s.rx_rate_kbs);
        // 推进到 t=2.5：cutoff=0.5，t=0 的采样滑出；span=2.5-1=1.5s → 1024/1.5/1024 ≈ 0.6667
        set_t(2.5);
        let s = tracker.snapshot();
        assert!(
            (s.rx_rate_kbs - 1.0 / 1.5).abs() < 1e-9,
            "got {}",
            s.rx_rate_kbs
        );
        // 推进到 t=10：全部滑出窗口 → 速率为 0
        set_t(10.0);
        assert_eq!(tracker.snapshot().rx_rate_kbs, 0.0);
        assert_eq!(tracker.snapshot().rx_bytes, 2048); // 总量不受窗口影响
    }

    #[test]
    fn error_counters() {
        let t = StatsTracker::new();
        t.record_crc_error();
        t.record_crc_error();
        t.record_frame_error();
        let s = t.snapshot();
        assert_eq!(s.crc_errors, 2);
        assert_eq!(s.frame_errors, 1);
    }
}
