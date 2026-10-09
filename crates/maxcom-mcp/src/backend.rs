//! 上层需要为 MCP 提供的**唯一**能力：会话寻址。
//!
//! 为什么只留这一件事：枚举串口/USB/HID/探针、烧录等全是 `maxcom-engine` 的自由函数，
//! 不需要任何上层状态；只有「会话表」由 Tauri 的 `AppState` 持有。
//! 把 trait 压到最小，既让 src-tauri 的实现只有十几行，也让测试可以完全脱离 Tauri。

use maxcom_engine::session::{ConnState, LogEntryDto, SessionEvents, SessionManager};
use std::sync::{Arc, Mutex};

/// 会话寻址（app/src-tauri 由 `AppState` 实现；测试用 [`TestBackend`]）。
pub trait Backend: Send + Sync + 'static {
    /// 列出当前存在的会话 id（前端标签页 + AI 自建的会话）。
    /// **顺序不限** —— 工具层会排序后再输出，实现方不必关心。
    fn list_sessions(&self) -> Vec<String>;

    /// 取会话；不存在返回 `None`。
    ///
    /// 只读工具用它 —— 拼错会话 id 时报「会话不存在」而不是悄悄造一个空会话，
    /// 否则 AI 会对着一个永远没数据的会话反复读取却查不出原因。
    fn session(&self, id: &str) -> Option<Arc<SessionManager>>;

    /// 取或创建会话。
    ///
    /// 控制类工具（connect/send/…）用它：允许 AI 自建一个会话去打开端口，
    /// 不必先要求用户在界面上开好标签页。
    fn session_or_create(&self, id: &str) -> Arc<SessionManager>;

    /// 关闭会话并回收其线程与设备句柄
    fn close_session(&self, id: &str);

    /// 应用版本（`server_info` 展示用；默认取本 crate 版本）
    fn app_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

/// 丢弃全部回调的事件出口。
///
/// 用于测试与无头场景：`SessionManager` 必须有一个事件出口，但 MCP 侧不消费
/// 面向 UI 的 raw/entries/state 流（它走 [`SessionManager::io_since`] 主动查询）。
pub struct NullEvents;

impl SessionEvents for NullEvents {
    fn raw(&self, _data: &[u8]) {}
    fn entries(&self, _entries: &[LogEntryDto]) {}
    fn state(&self, _state: &ConnState) {}
}

/// 内存会话表：不依赖 Tauri 的 [`Backend`] 实现（单元 / 集成测试用）。
#[derive(Default)]
pub struct TestBackend {
    sessions: Mutex<Vec<(String, Arc<SessionManager>)>>,
}

impl TestBackend {
    pub fn new() -> Self {
        Self::default()
    }

    /// 预置一个会话（模拟界面上已打开的标签页）
    pub fn with_session(self, id: &str) -> Self {
        self.session_or_create(id);
        self
    }
}

impl Backend for TestBackend {
    fn list_sessions(&self) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn session(&self, id: &str) -> Option<Arc<SessionManager>> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(s, _)| s == id)
            .map(|(_, m)| m.clone())
    }

    fn session_or_create(&self, id: &str) -> Arc<SessionManager> {
        let mut g = self.sessions.lock().unwrap();
        if let Some((_, m)) = g.iter().find(|(s, _)| s == id) {
            return m.clone();
        }
        let mgr = Arc::new(SessionManager::new(Arc::new(NullEvents)));
        g.push((id.to_string(), mgr.clone()));
        mgr
    }

    fn close_session(&self, id: &str) {
        let taken = {
            let mut g = self.sessions.lock().unwrap();
            g.iter().position(|(s, _)| s == id).map(|i| g.remove(i))
        };
        if let Some((_, m)) = taken {
            // Drop 会 disconnect 并回收线程；显式 disconnect 让设备句柄在此刻就释放
            m.disconnect();
        }
    }
}
