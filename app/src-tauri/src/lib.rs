//! MAXCOM Tauri 外壳：commands ↔ SessionManager，events → 前端。
//! 业务逻辑全部在 maxcom-core / maxcom-engine；本 crate 只做参数搬运与事件发射。

pub mod commands;
pub mod events;

use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let events = Arc::new(events::TauriEvents::new(app.handle().clone()));
            app.manage(commands::AppState::new(events));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_ports,
            commands::connect,
            commands::disconnect,
            commands::send,
            commands::set_log_options,
            commands::set_filters,
            commands::set_color_rules,
            commands::clear_log,
            commands::get_stats,
            commands::set_plot_format,
            commands::plot_snapshot,
            commands::set_dtr,
            commands::set_rts,
            commands::set_auto_reconnect,
            commands::start_capture,
            commands::save_capture,
            commands::capture_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MAXCOM");
}
