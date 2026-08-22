//! Tauri commands：前端 invoke 的入口。全部是薄转发，逻辑在 maxcom-engine。
//! 多会话：每个标签页一个独立 SessionManager，按前端传来的 session id 索引；
//! 首次访问惰性创建（自带会话标签的事件出口），close_session 时移除并断开。

use crate::events::TauriEvents;
use maxcom_core::colorize::ColorRule;
use maxcom_core::filter::FilterRule;
use maxcom_core::plot::format::DataFormat;
use maxcom_core::stats::StatsSnapshot;
use maxcom_engine::session::{LogOptions, PlotSnapshotDto, SendPayload, SessionManager};
use maxcom_engine::transport::{ConnConfig, PortInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

/// 全局应用状态：session id → 会话管理器
pub struct AppState {
    app: AppHandle,
    sessions: Mutex<HashMap<String, SessionManager>>,
}

impl AppState {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 取（或创建）指定会话的 SessionManager 并执行闭包
    pub fn with<T>(&self, session: &str, f: impl FnOnce(&SessionManager) -> T) -> T {
        let mut map = self.sessions.lock().unwrap();
        let mgr = map.entry(session.to_string()).or_insert_with(|| {
            let events = Arc::new(TauriEvents::new(self.app.clone(), session.to_string()));
            SessionManager::new(events)
        });
        f(mgr)
    }

    /// 关闭会话：移除即触发 Drop → 断开连接、停线程
    pub fn close(&self, session: &str) {
        self.sessions.lock().unwrap().remove(session);
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LogOptionsDto {
    pub idle_timeout_ms: u64,
    pub timestamp_mode: String,
    pub encoding: String,
}

impl From<LogOptionsDto> for LogOptions {
    fn from(d: LogOptionsDto) -> Self {
        Self {
            idle_timeout_ms: d.idle_timeout_ms,
            timestamp_mode: maxcom_core::framing::TimestampMode::parse(&d.timestamp_mode)
                .unwrap_or_default(),
            encoding: d.encoding,
        }
    }
}

#[tauri::command]
pub fn list_ports() -> Vec<PortInfo> {
    maxcom_engine::transport::discover_serial_ports()
}

#[tauri::command]
pub fn connect(
    session: String,
    config: ConnConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.with(&session, |mgr| mgr.connect(config))
}

#[tauri::command]
pub fn disconnect(session: String, state: State<'_, AppState>) {
    state.with(&session, |mgr| mgr.disconnect());
}

#[tauri::command]
pub fn send(
    session: String,
    payload: SendPayload,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    state.with(&session, |mgr| mgr.send(&payload))
}

#[tauri::command]
pub fn set_log_options(session: String, o: LogOptionsDto, state: State<'_, AppState>) {
    state.with(&session, |mgr| mgr.set_log_options(o.into()));
}

#[tauri::command]
pub fn set_filters(session: String, rules: Vec<FilterRule>, state: State<'_, AppState>) {
    state.with(&session, |mgr| mgr.set_filters(rules));
}

#[tauri::command]
pub fn set_color_rules(
    session: String,
    master: bool,
    ansi_yield: bool,
    rules: Vec<ColorRule>,
    state: State<'_, AppState>,
) {
    state.with(&session, |mgr| {
        mgr.set_color_rules(master, ansi_yield, rules)
    });
}

#[tauri::command]
pub fn clear_log(session: String, state: State<'_, AppState>) {
    state.with(&session, |mgr| mgr.clear_log());
}

#[tauri::command]
pub fn get_stats(session: String, state: State<'_, AppState>) -> StatsSnapshot {
    state.with(&session, |mgr| mgr.stats())
}

#[tauri::command]
pub fn set_plot_format(session: String, fmt: DataFormat, state: State<'_, AppState>) {
    state.with(&session, |mgr| mgr.set_plot_format(fmt));
}

#[tauri::command]
pub fn set_plot_buffer(session: String, capacity: u32, state: State<'_, AppState>) {
    state.with(&session, |mgr| mgr.set_plot_buffer(capacity as usize));
}

#[tauri::command]
pub fn plot_snapshot(
    session: String,
    max_points: u32,
    state: State<'_, AppState>,
) -> PlotSnapshotDto {
    state.with(&session, |mgr| mgr.plot_snapshot(max_points as usize))
}

#[tauri::command]
pub fn set_dtr(session: String, on: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.with(&session, |mgr| mgr.set_dtr(on))
}

#[tauri::command]
pub fn set_rts(session: String, on: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.with(&session, |mgr| mgr.set_rts(on))
}

#[tauri::command]
pub fn set_auto_reconnect(session: String, on: bool, state: State<'_, AppState>) {
    state.with(&session, |mgr| mgr.set_auto_reconnect(on));
}

#[tauri::command]
pub fn start_capture(session: String, state: State<'_, AppState>) {
    state.with(&session, |mgr| mgr.start_capture());
}

/// 停止捕获并落盘（path 由前端 dialog 插件取得），返回写入字节数
#[tauri::command]
pub fn save_capture(
    session: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    state.with(&session, |mgr| mgr.save_capture(&path))
}

/// (捕获中?, 已捕获字节, 超限丢弃字节)
#[tauri::command]
pub fn capture_state(session: String, state: State<'_, AppState>) -> (bool, u64, u64) {
    state.with(&session, |mgr| mgr.capture_state())
}

/// 标签页关闭时调用：销毁该会话（断开连接、回收线程）
#[tauri::command]
pub fn close_session(session: String, state: State<'_, AppState>) {
    state.close(&session);
}

/// 保存任意文本文件（CSV 导出等；path 由前端 dialog 插件取得），返回写入字节数
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<usize, String> {
    std::fs::write(&path, contents.as_bytes()).map_err(|e| e.to_string())?;
    Ok(contents.len())
}
