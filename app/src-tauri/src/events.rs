//! 事件出口：SessionEvents trait 的 Tauri 实现（emit 到前端）。
//! 多会话：所有负载携带 session 标签，前端按标签路由到对应标签页。

use base64::Engine;
use maxcom_engine::session::{ConnState, LogEntryDto, SessionEvents};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EV_RAW: &str = "conn://raw";
pub const EV_ENTRIES: &str = "conn://entries";
pub const EV_STATE: &str = "conn://state";

#[derive(Serialize, Clone)]
struct RawPayload {
    session: String,
    b64: String,
}

#[derive(Serialize, Clone)]
struct EntriesPayload<'a> {
    session: String,
    epoch_anchor_ms: u64,
    items: &'a [LogEntryDto],
}

/// 连接状态负载：嵌套 { session, state }（与前端 api.ts / mock.ts 的形状一致）
#[derive(Serialize, Clone)]
struct StatePayload<'a> {
    session: String,
    state: &'a ConnState,
}

/// absolute 时间戳锚点：wall = anchor + ts_ms(monotonic)。进程内取一次，漂移可忽略。
fn unix_anchor_ms() -> u64 {
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let mono = START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64;
    unix.saturating_sub(mono)
}

pub struct TauriEvents {
    app: AppHandle,
    anchor: u64,
    session: String,
}

impl TauriEvents {
    pub fn new(app: AppHandle, session: String) -> Self {
        Self {
            app,
            anchor: unix_anchor_ms(),
            session,
        }
    }
}

impl SessionEvents for TauriEvents {
    fn raw(&self, data: &[u8]) {
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        let _ = self.app.emit(
            EV_RAW,
            RawPayload {
                session: self.session.clone(),
                b64,
            },
        );
    }

    fn entries(&self, entries: &[LogEntryDto]) {
        let _ = self.app.emit(
            EV_ENTRIES,
            EntriesPayload {
                session: self.session.clone(),
                epoch_anchor_ms: self.anchor,
                items: entries,
            },
        );
    }

    fn state(&self, state: &ConnState) {
        let _ = self.app.emit(
            EV_STATE,
            StatePayload {
                session: self.session.clone(),
                state,
            },
        );
    }
}
