//! Tauri commands：前端 invoke 的入口。全部是薄转发，逻辑在 maxcom-engine。
//! 多会话：每个标签页一个独立 SessionManager，按前端传来的 session id 索引；
//! 首次访问惰性创建（自带会话标签的事件出口），close_session 时移除并断开。

use crate::events::TauriEvents;
use maxcom_core::colorize::ColorRule;
use maxcom_core::filter::FilterRule;
use maxcom_core::plot::format::DataFormat;
use maxcom_core::stats::StatsSnapshot;
use maxcom_engine::session::{ConnState, LogOptions, PlotSnapshotDto, SendPayload, SessionManager};
#[cfg(feature = "desktop")]
use maxcom_engine::transport::{ChipFamilyInfo, FlashConfig, ProbeInfo};
use maxcom_engine::transport::{ConnConfig, PortInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// 全局应用状态：session id → 会话管理器
pub struct AppState {
    app: AppHandle,
    sessions: Mutex<HashMap<String, Arc<SessionManager>>>,
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
        let mgr = self.get_or_create(session);
        f(&mgr)
    }

    /// 取（或创建）会话句柄（Arc 克隆），返回后不再持有 sessions 全局锁。
    /// 供长时间/阻塞命令在锁外、甚至阻塞线程池里执行。
    pub fn get_or_create(&self, session: &str) -> Arc<SessionManager> {
        let mut map = self.sessions.lock().unwrap();
        map.entry(session.to_string())
            .or_insert_with(|| {
                let events = Arc::new(TauriEvents::new(self.app.clone(), session.to_string()));
                Arc::new(SessionManager::new(events))
            })
            .clone()
    }

    /// 取出会话句柄（Arc 克隆）；会话不存在返回 None。
    pub fn get_mgr(&self, session: &str) -> Option<Arc<SessionManager>> {
        self.sessions.lock().unwrap().get(session).cloned()
    }

    /// 关闭会话：移除即触发 Drop → 断开连接、停线程。
    /// 正在进行的连接尝试一并取消（否则标签页关了，后台还在握手并可能装上一个会话）。
    pub fn close(&self, session: &str) {
        let mgr = self.sessions.lock().unwrap().remove(session);
        if let Some(m) = mgr {
            m.cancel_connect();
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LogOptionsDto {
    pub idle_timeout_ms: u64,
    pub timestamp_mode: String,
    pub encoding: String,
    #[serde(default)]
    pub split_mode: String,
}

impl From<LogOptionsDto> for LogOptions {
    fn from(d: LogOptionsDto) -> Self {
        Self {
            idle_timeout_ms: d.idle_timeout_ms,
            timestamp_mode: maxcom_core::framing::TimestampMode::parse(&d.timestamp_mode)
                .unwrap_or_default(),
            encoding: d.encoding,
            split_mode: if d.split_mode == "line" {
                "line".into()
            } else {
                "timeout".into()
            },
        }
    }
}

/// 枚举串口。系统枚举（尤其含蓝牙虚拟串口时）可能耗时上百毫秒，
/// 丢到阻塞线程池，避免同步命令在主线程上卡住界面。
#[tauri::command]
pub async fn list_ports() -> Result<Vec<PortInfo>, String> {
    tauri::async_runtime::spawn_blocking(maxcom_engine::transport::discover_serial_ports)
        .await
        .map_err(|e| format!("枚举串口异常: {e}"))
}

/// 按编码把字符串转为字节（校验计算器等工具用）。返回 (字节数组, 是否含无法编码字符)。
/// enc 支持 utf-8 / gbk / gb2312 / latin-1（与 maxcom-core SUPPORTED_ENCODINGS 对齐）。
#[tauri::command]
pub fn encode_text(text: String, encoding: String) -> Result<(Vec<u8>, bool), String> {
    Ok(maxcom_core::encoding::encode(&text, &encoding))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn list_probes() -> Result<Vec<ProbeInfo>, String> {
    tauri::async_runtime::spawn_blocking(maxcom_engine::transport::discover_probes)
        .await
        .map_err(|e| format!("枚举探针异常: {e}"))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn list_chips() -> Vec<ChipFamilyInfo> {
    maxcom_engine::transport::chip_list()
}

/// 枚举 USB 设备（winusb 传输的设备下拉）
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn list_usb_devices() -> Result<Vec<maxcom_engine::transport::UsbDeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(maxcom_engine::transport::discover_usb_devices)
        .await
        .map_err(|e| format!("枚举 USB 设备异常: {e}"))
}

/// 枚举 HID 设备（hid 传输的设备下拉）
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn list_hid_devices() -> Result<Vec<maxcom_engine::transport::HidDeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(maxcom_engine::transport::discover_hid_devices)
        .await
        .map_err(|e| format!("枚举 HID 设备异常: {e}"))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn flash_firmware(config: FlashConfig, app: AppHandle) -> Result<String, String> {
    use crate::events::{FlashProgressPayload, EV_FLASH};
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        maxcom_engine::transport::flashing::flash(&config, move |p| {
            let _ = app2.emit(EV_FLASH, FlashProgressPayload { progress: p });
        })
    })
    .await
    .map_err(|e| format!("烧录任务异常: {e}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn modem_transfer(
    session: String,
    protocol: maxcom_engine::transport::ModemProtocol,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::events::{FlashProgressPayload, EV_FLASH};
    // 先取出会话句柄（释放 sessions 全局锁），再把阻塞的协议传输丢到阻塞线程池，
    // 避免主线程/全局锁被 ZMODEM 无响应时的长等待（10s~120s）卡死 UI。
    let mgr = state
        .get_mgr(&session)
        .ok_or_else(|| "会话不存在或已关闭".to_string())?;
    let app = state.app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mgr.modem_transfer(
            protocol,
            path,
            move |p: &maxcom_engine::transport::ModemProgress| {
                let _ = app.emit(
                    EV_FLASH,
                    FlashProgressPayload {
                        progress: maxcom_engine::transport::flashing::FlashProgressDto {
                            kind: p.kind.to_string(),
                            operation: p.operation.clone(),
                            size: p.size,
                            total: p.total,
                            message: p.message.clone().unwrap_or_default(),
                        },
                    },
                );
            },
        )
    })
    .await
    .map_err(|e| format!("modem 传输任务异常: {e}"))?
}

/// 强制停止当前会话的 modem 传输（置位取消位；协议层在下一轮轮询/读取时退出）。
/// 标量调用，无阻塞，无传输进行时无害。
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn cancel_modem_transfer(session: String, state: State<'_, AppState>) -> Result<(), String> {
    let mgr = state
        .get_mgr(&session)
        .ok_or_else(|| "会话不存在或已关闭".to_string())?;
    mgr.cancel_modem_transfer();
    Ok(())
}

/// 开始一次连接（**非阻塞**）：立即返回，过程/结果经 `conn://state` 事件广播
/// （connecting → connected | failed）。前端据此把按钮切成「取消 + 转圈」，
/// 点取消调 [`cancel_connect`]。
///
/// 为什么不能同步做 open：串口 open / SSH 握手（超时 20s）会阻塞调用线程，
/// 而 Tauri 同步命令跑在主线程 → 高延迟网络下点「连接」直接卡死整个界面。
#[tauri::command]
pub async fn connect(
    session: String,
    config: ConnConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.get_or_create(&session);
    tauri::async_runtime::spawn_blocking(move || mgr.begin_connect(config))
        .await
        .map_err(|e| format!("连接任务异常: {e}"))?
}

/// 取消进行中的连接尝试（立即返回；底层握手结果会被丢弃）
#[tauri::command]
pub fn cancel_connect(session: String, state: State<'_, AppState>) -> bool {
    state.with(&session, |mgr| mgr.cancel_connect())
}

/// 断开当前会话（含中止自动重连循环与进行中的连接尝试）。
/// join 引擎线程可能短暂等待，故丢到阻塞线程池，避免卡主线程。
#[tauri::command]
pub async fn disconnect(session: String, state: State<'_, AppState>) -> Result<(), String> {
    let mgr = state.get_or_create(&session);
    tauri::async_runtime::spawn_blocking(move || mgr.disconnect())
        .await
        .map_err(|e| format!("断开任务异常: {e}"))
}

/// 主动查询当前连接状态（按 ConnPhase 上报，前端据此渲染按钮/指示灯）
#[tauri::command]
pub fn conn_state(session: String, state: State<'_, AppState>) -> ConnState {
    state.with(&session, |mgr| mgr.conn_state())
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
pub fn resize_pty(
    session: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.with(&session, |mgr| mgr.resize_pty(cols, rows))
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

/// 取消捕获：丢弃临时文件，不保存
#[tauri::command]
pub fn cancel_capture(session: String, state: State<'_, AppState>) {
    state.with(&session, |mgr| mgr.cancel_capture());
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
