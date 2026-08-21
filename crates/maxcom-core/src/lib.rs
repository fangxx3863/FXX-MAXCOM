//! MAXCOM 纯逻辑引擎（ADR-0018）。
//!
//! 全部业务规则都在本 crate，且**不依赖任何 IO / GUI**，保证可以全量单元测试（R3）。
//! 分层铁律：core 不依赖 engine，engine 不依赖 tauri。
//!
//! 原则：**库优先**（ADR-0018 技术栈锁）——编码检测用 chardetng、ANSI tokenize 用 ansitok、
//! 环形缓冲用 ringbuffer；自研只保留 MAXCOM 特有业务规则（分包策略/染色规则链/统计口径）。

pub mod ansistrip;
pub mod bus;
pub mod colorize;
pub mod encoding;
pub mod filter;
pub mod framing;
pub mod plot;
pub mod splitter;
pub mod stats;
