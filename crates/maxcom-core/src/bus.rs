//! 事件总线（ADR-0015：单一原始流扇出 + 各引擎独立消费）。
//!
//! 库优先：队列用 `crossbeam-channel`（无界，对齐 Python 版 queue.Queue 语义）。
//! 本类型只是扇出语义的薄封装；引擎间不共享可变状态。

use crossbeam_channel::{unbounded, Receiver, Sender};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

type Sink = Sender<Chunk>;

/// 数据方向：`Rx` = 链路 → 主机（真实接收），`Tx` = 主机 → 链路（仅本地回显回流）。
///
/// 定义在 core（而非各引擎各写一份）是为了让**总线载荷与引擎 DTO 共用同一个方向概念**：
/// 引擎的 `IoDir`（MCP `read_io`）与 `LogEntryDto.dir`（收发区方向标记）都是它，
/// 避免"同一个语义两套枚举"在跨层传参时发生错配。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dir {
    /// 接收（链路 → 主机）
    #[default]
    Rx,
    /// 发送（主机 → 链路）
    Tx,
}

/// 总线载荷：原始字节 + 方向标签。
///
/// 方向必须**随字节一起**走：日志管线由接收与本地回显两条来源共用，只有在入队处就贴上
/// 标签，才能既保住到达顺序、又让下游区分"设备发来的"与"我刚发出去的"。
#[derive(Debug, Clone)]
pub struct Chunk {
    pub bytes: Vec<u8>,
    pub dir: Dir,
}

impl Chunk {
    /// 接收方向的 chunk（绝大多数调用点：读线程）
    pub fn rx(bytes: &[u8]) -> Self {
        Self {
            bytes: bytes.to_vec(),
            dir: Dir::Rx,
        }
    }

    pub fn with_dir(bytes: &[u8], dir: Dir) -> Self {
        Self {
            bytes: bytes.to_vec(),
            dir,
        }
    }
}

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
    pub fn subscribe(&self, name: &str) -> Receiver<Chunk> {
        let (tx, rx) = unbounded();
        self.sinks.lock().unwrap().push((name.to_string(), tx));
        rx
    }

    /// 按名注销（移除该名的全部订阅）。
    pub fn unsubscribe(&self, name: &str) {
        self.sinks.lock().unwrap().retain(|(n, _)| n != name);
    }

    /// 发布**接收**方向的原始 chunk（读线程的唯一入口）。接收端已 drop（引擎停止）→ 忽略；
    /// 无订阅者是正常情况（终端模式原始流直推前端渲染）。
    pub fn publish(&self, data: &[u8]) {
        self.publish_as(data, Dir::Rx);
    }

    /// 以指定方向发布给**全部**订阅者。
    pub fn publish_as(&self, data: &[u8], dir: Dir) {
        let sinks = self.sinks.lock().unwrap();
        for (_, tx) in sinks.iter() {
            let _ = tx.send(Chunk::with_dir(data, dir));
        }
    }

    /// 只投递给指定名字的订阅者，并显式给出方向。
    ///
    /// 用于本地回显（`Dir::Tx`）：把本机发送的字节按「到达」喂给日志管线，但**不能**顺带
    /// 喂给绘图订阅者，否则发送内容会被当成接收帧解析、污染曲线。
    pub fn publish_to(&self, name: &str, data: &[u8], dir: Dir) {
        let sinks = self.sinks.lock().unwrap();
        for (n, tx) in sinks.iter() {
            if n == name {
                let _ = tx.send(Chunk::with_dir(data, dir));
            }
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
    fn publish_to_targets_single_topic() {
        let bus = Bus::new();
        let log = bus.subscribe("log");
        let plot = bus.subscribe("plot");
        bus.publish_to("log", b"tx", Dir::Tx);
        let got = log.recv().unwrap();
        assert_eq!(got.bytes, b"tx");
        assert_eq!(
            got.dir,
            Dir::Tx,
            "定向发布须带上调用方给出的方向（本地回显 = Tx）"
        );
        assert!(plot.try_recv().is_err(), "绘图订阅者不应收到定向消息");
    }

    #[test]
    fn fans_out_to_all_subscribers() {
        let bus = Bus::new();
        let a = bus.subscribe("logview");
        let b = bus.subscribe("plot");
        bus.publish(b"hello");
        let (ca, cb) = (a.recv().unwrap(), b.recv().unwrap());
        assert_eq!(ca.bytes, b"hello");
        assert_eq!(cb.bytes, b"hello");
        assert_eq!((ca.dir, cb.dir), (Dir::Rx, Dir::Rx), "publish 即接收方向");
        assert_eq!(bus.subscriber_count(), 2);
    }

    /// 方向是逐 chunk 的属性，同一订阅者先后收到两种方向必须分别保真（不能粘上一次的值）。
    #[test]
    fn direction_is_per_chunk() {
        let bus = Bus::new();
        let log = bus.subscribe("log");
        bus.publish(b"from device");
        bus.publish_to("log", b"from host", Dir::Tx);
        bus.publish(b"from device again");
        let dirs: Vec<Dir> = (0..3).map(|_| log.recv().unwrap().dir).collect();
        assert_eq!(dirs, vec![Dir::Rx, Dir::Tx, Dir::Rx]);
    }

    /// 序列化取值被前端按 "rx"/"tx" 消费（types.ts 的 LogEntryDto.dir），改动即破坏契约。
    #[test]
    fn dir_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&Dir::Rx).unwrap(), "\"rx\"");
        assert_eq!(serde_json::to_string(&Dir::Tx).unwrap(), "\"tx\"");
        assert_eq!(serde_json::from_str::<Dir>("\"tx\"").unwrap(), Dir::Tx);
        assert_eq!(Dir::default(), Dir::Rx, "缺省方向必须是接收");
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
