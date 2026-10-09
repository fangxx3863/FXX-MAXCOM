//! MAXCOM MCP 服务端（ADR-0021）。
//!
//! 把 MAXCOM 的能力以 [Model Context Protocol] 工具的形式暴露给 AI 助手：
//! 枚举串口 / USB / HID / 调试探针、读取会话最近 I/O、建立与操作连接、固件烧录等。
//!
//! # 分层位置
//!
//! ```text
//! maxcom-core  纯逻辑
//!   └ maxcom-engine  传输 + 会话编排
//!       └ maxcom-mcp   ← 本 crate：MCP 协议与工具契约（不依赖 Tauri）
//!           └ app/src-tauri  只实现 Backend（会话寻址）并启动 HTTP 服务
//! ```
//!
//! 本 crate **只依赖 engine**，并且只要求上层提供一件东西 —— [`Backend`]（会话寻址）。
//! 枚举类工具全部直接调用 engine 的自由函数，因此这个 trait 极小：
//! 既好用真实实现替换，也能在测试里换成内存实现（见 [`TestBackend`]）。
//!
//! # 传输
//!
//! 仅提供 **Streamable HTTP** 服务端（[`serve_http`]），且强制只绑定回环地址 ——
//! 它能读写串口并烧录固件，暴露到网络等于给出远端任意刷写设备的能力。
//!
//! # feature
//!
//! 全部实现位于 `server` feature 之后（默认关闭），以免拖慢工作区轻量路径；
//! 关闭时本 crate 是一个空库。
//!
//! [Model Context Protocol]: https://modelcontextprotocol.io

#![cfg_attr(not(feature = "server"), allow(unused_crate_dependencies))]

#[cfg(feature = "server")]
mod backend;
#[cfg(feature = "server")]
mod http;
#[cfg(feature = "server")]
mod server;

#[cfg(feature = "server")]
pub use backend::{Backend, NullEvents, TestBackend};
#[cfg(feature = "server")]
pub use http::{serve_http, HttpHandle, HttpOptions, DEFAULT_PORT, DEFAULT_ROUTE};
#[cfg(feature = "server")]
pub use server::{MaxcomMcp, DEFAULT_SESSION};
