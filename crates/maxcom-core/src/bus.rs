//! 事件总线（移植自 `pipeline/event_bus.py`，ADR-0015）。
//!
//! 单一原始流扇出：传输层读到的每个 chunk 发布一次，各引擎（日志/绘图/统计）
//! 各自持有独立队列消费，互不耦合、互不修改原始流（R9 数据流纪律）。
//!
//! Python 版用 `queue.Queue`（无界）；这里用 `std::sync::mpsc` 无界通道对齐语义。

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;

type Sink = Sender<Vec<u8>>;

/// 多消费者扇出总线。`publish` 对每个订阅者克隆一份数据。
#[derive(Default)]
pub struct Bus {
    sinks: Mutex<Vec<(String, Sink)>>,
}

impl Bus {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册订阅者，返回其私有接收端。同名可重复订阅（与 Python 版一致）。
    pub fn subscribe(&self, name: &str) -> Receiver<Vec<u8>> {
        let (tx, rx) = channel();
        self.sinks.lock().unwrap().push((name.to_string(), tx));
        rx
    }

    /// 按名注销（移除该名的全部订阅）。
    pub fn unsubscribe(&self, name: &str) {
        self.sinks.lock().unwrap().retain(|(n, _)| n != name);
    }

    /// 发布原始 chunk：克隆给所有订阅者。无订阅者是正常情况（终端模式直传前端）。
    pub fn publish(&self, data: &[u8]) {
        let sinks = self.sinks.lock().unwrap();
        for (_, tx) in sinks.iter() {
            // 接收端已 drop（引擎停止）→ 忽略
            let _ = tx.send(data.to_vec());
        }
    }

    pub fn subscriber_count(&self) -> usize {
        self.sinks.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TryRecvError;

    #[test]
    fn fans_out_to_all_subscribers() {
        let bus = Bus::new();
        let a = bus.subscribe("logview");
        let b = bus.subscribe("plot");
        bus.publish(b"hello");
        assert_eq!(a.recv().unwrap(), b"hello");
        assert_eq!(b.recv().unwrap(), b"hello");
        assert_eq!(bus.subscriber_count(), 2);
    }

    #[test]
    fn unsubscribe_stops_delivery() {
        let bus = Bus::new();
        let a = bus.subscribe("logview");
        bus.unsubscribe("logview");
        bus.publish(b"x");
        assert!(matches!(a.try_recv(), Err(TryRecvError::Disconnected)));
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[test]
    fn publish_with_no_subscribers_is_ok() {
        let bus = Bus::new();
        bus.publish(b"nobody listens");
    }
}
