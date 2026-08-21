//! MAXCOM 纯逻辑引擎（ADR-0018）。
//!
//! 全部业务规则都在本 crate，且**不依赖任何 IO / GUI**，保证全量单元测试可验。
//! 分层铁律：core 不依赖 engine，engine 不依赖 tauri。
//!
//! 原则：库优先（ADR-0018 技术栈锁），自研只保留 MAXCOM 特有业务规则。
