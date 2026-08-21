//! MAXCOM 传输与会话编排（ADR-0018）。
//!
//! 架构（对齐 ADR-0015 单一原始流纪律）：
//!
//! ```text
//!            ┌─→ raw 批量回调（→ 前端 xterm.js / 事件）
//! 读线程 ──┤
//!            └─→ Bus 扇出 ─→ LogEngine 线程（分行/染色/过滤 → 批量 entry 回调）
//!                        └→ PlotEngine（帧解析 → ChannelStore，前端轮询快照）
//! 写路径：write() → TransportWrite（独立句柄，不与读线程争抢）
//! ```
//!
//! 传输可注入（`LoopbackTransport` / TCP 回环）做集成测试，不依赖真实硬件。

pub mod session;
pub mod transport;
