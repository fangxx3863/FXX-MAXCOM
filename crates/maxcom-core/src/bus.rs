//! 事件总线（ADR-0015：单一原始流扇出 + 各引擎独立消费）。
//!
//! 库优先：队列用 `crossbeam-channel`（无界，对齐 Python 版 queue.Queue 语义）。
//! 本类型只是扇出语义的薄封装；引擎间不共享可变状态。

use crossbeam_channel::{unbounded, Receiver, Sender};
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

    /// 注册订阅者，返回其私有接收端。同名可重复订阅。
    pub fn subscribe(&self, name: &str) -> Receiver<Vec<u8>> {
        let (tx, rx) = unbounded();
        self.sinks.lock().unwrap().push((name.to_string(), tx));
        rx
    }

    /// 按名注销（移除该名的全部订阅）。
    pub fn unsubscribe(&self, name: &str) {
        self.sinks.lock().unwrap().retain(|(n, _)| n != name);
    }

    /// 发布原始 chunk。接收端已 drop（引擎停止）→ 忽略；无订阅者是正常情况
    /// （终端模式原始流直推前端渲染）。
    pub fn publish(&self, data: &[u8]) {
        let sinks = self.sinks.lock().unwrap();
        for (_, tx) in sinks.iter() {
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
    use crossbeam_channel::TryRecvError;

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
    fn unsubscribe_stops_delivery_and_disconnects() {
        let bus = Bus::new();
        let a = bus.subscribe("logview");
        bus.unsubscribe("logview");
        bus.publish(b"x");
        assert!(matches!(a.try_recv(), Err(TryRecvError::Disconnected)));
    }

    #[test]
    fn publish_with_no_subscribers_is_ok() {
        Bus::new().publish(b"nobody listens");
    }
}
