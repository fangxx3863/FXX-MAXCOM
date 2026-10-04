//! 事件出口：SessionEvents trait 的 Tauri 实现（emit 到前端）。
//! 多会话：所有负载携带 session 标签，前端按标签路由到对应标签页。

use base64::Engine;
use maxcom_engine::session::{ConnState, LogEntryDto, SessionEvents};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EV_RAW: &str = "conn://raw";
pub const EV_ENTRIES: &str = "conn://entries";
pub const EV_STATE: &str = "conn://state";
#[cfg(feature = "desktop")]
pub const EV_FLASH: &str = "flash://progress";

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

/// 烧录进度负载（全局：烧录是跨标签单探针操作，不携带 session 标签）。
/// 前端各 FlashPage 监听，仅当前处于烧录中的页面响应。
#[cfg(feature = "desktop")]
#[derive(Serialize, Clone)]
pub struct FlashProgressPayload {
    pub progress: maxcom_engine::transport::flashing::FlashProgressDto,
}

pub struct TauriEvents {
    app: AppHandle,
    session: String,
}

impl TauriEvents {
    pub fn new(app: AppHandle, session: String) -> Self {
        Self { app, session }
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
        // anchor 每批实时重算（而非启动时缓存）：`ts_ms` 走单调钟，系统休眠期间不前进，
        // 长跑进程跨过一次睡眠后 "anchor(启动时) + ts_ms" 会比真实墙钟偏慢（睡眠多久慢多久）。
        // 实时取 `wall_anchor_ms()` 让每个批次的绝对基准都对齐当前墙钟，消除该漂移。
        let anchor = maxcom_engine::session::wall_anchor_ms().max(0) as u64;
        let _ = self.app.emit(
            EV_ENTRIES,
            EntriesPayload {
                session: self.session.clone(),
                epoch_anchor_ms: anchor,
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
