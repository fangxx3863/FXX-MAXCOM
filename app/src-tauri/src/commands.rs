//! Tauri commands：前端 invoke 的入口。全部是薄转发，逻辑在 maxcom-engine。

use crate::events::TauriEvents;
use maxcom_core::colorize::ColorRule;
use maxcom_core::filter::FilterRule;
use maxcom_core::plot::format::DataFormat;
use maxcom_core::stats::StatsSnapshot;
use maxcom_engine::session::{LogOptions, PlotSnapshotDto, SendPayload, SessionManager};
use maxcom_engine::transport::{ConnConfig, PortInfo};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

/// 全局应用状态
pub struct AppState {
    mgr: SessionManager,
}

impl AppState {
    pub fn new(events: Arc<TauriEvents>) -> Self {
        Self { mgr: SessionManager::new(events) }
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
pub fn connect(config: ConnConfig, state: State<'_, AppState>) -> Result<(), String> {
    state.mgr.connect(config)
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>) {
    state.mgr.disconnect();
}

#[tauri::command]
pub fn send(payload: SendPayload, state: State<'_, AppState>) -> Result<usize, String> {
    state.mgr.send(&payload)
}

#[tauri::command]
pub fn set_log_options(o: LogOptionsDto, state: State<'_, AppState>) {
    state.mgr.set_log_options(o.into());
}

#[tauri::command]
pub fn set_filters(rules: Vec<FilterRule>, state: State<'_, AppState>) {
    state.mgr.set_filters(rules);
}

#[tauri::command]
pub fn set_color_rules(
    master: bool,
    ansi_yield: bool,
    rules: Vec<ColorRule>,
    state: State<'_, AppState>,
) {
    state.mgr.set_color_rules(master, ansi_yield, rules);
}

#[tauri::command]
pub fn clear_log(state: State<'_, AppState>) {
    state.mgr.clear_log();
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> StatsSnapshot {
    state.mgr.stats()
}

#[tauri::command]
pub fn set_plot_format(fmt: DataFormat, state: State<'_, AppState>) {
    state.mgr.set_plot_format(fmt);
}

#[tauri::command]
pub fn plot_snapshot(max_points: u32, state: State<'_, AppState>) -> PlotSnapshotDto {
    state.mgr.plot_snapshot(max_points as usize)
}
