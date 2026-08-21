//! 事件出口：SessionEvents trait 的 Tauri 实现（emit 到前端）。

use base64::Engine;
use maxcom_engine::session::{ConnState, LogEntryDto, SessionEvents};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EV_RAW: &str = "conn://raw";
pub const EV_ENTRIES: &str = "conn://entries";
pub const EV_STATE: &str = "conn://state";

#[derive(Serialize)]
struct RawPayload {
    b64: String,
}

#[derive(Serialize)]
struct EntriesPayload<'a> {
    epoch_anchor_ms: u64,
    items: &'a [LogEntryDto],
}

/// absolute 时间戳锚点：wall = anchor + ts_ms(monotonic)。进程内取一次，漂移可忽略。
fn unix_anchor_ms() -> u64 {
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let mono = START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64;
    unix.saturating_sub(mono)
}

pub struct TauriEvents {
    app: AppHandle,
    anchor: u64,
}

impl TauriEvents {
    pub fn new(app: AppHandle) -> Self {
        Self { app, anchor: unix_anchor_ms() }
    }
}

impl SessionEvents for TauriEvents {
    fn raw(&self, data: &[u8]) {
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        let _ = self.app.emit(EV_RAW, RawPayload { b64 });
    }

    fn entries(&self, entries: &[LogEntryDto]) {
        let _ = self.app.emit(EV_ENTRIES, EntriesPayload { epoch_anchor_ms: self.anchor, items: entries });
    }

    fn state(&self, state: &ConnState) {
        let _ = self.app.emit(EV_STATE, state);
    }
}
