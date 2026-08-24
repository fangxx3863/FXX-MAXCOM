//! MAXCOM Tauri 外壳：commands ↔ SessionManager，events → 前端。
//! 业务逻辑全部在 maxcom-core / maxcom-engine；本 crate 只做参数搬运与事件发射。
//! 多会话：每个标签页一个 SessionManager（见 commands::AppState），事件按 session 标签路由。

pub mod commands;
pub mod events;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(commands::AppState::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_ports,
            #[cfg(feature = "desktop")]
            commands::list_probes,
            #[cfg(feature = "desktop")]
            commands::list_chips,
            #[cfg(feature = "desktop")]
            commands::list_usb_devices,
            #[cfg(feature = "desktop")]
            commands::list_hid_devices,
            #[cfg(feature = "desktop")]
            commands::flash_firmware,
            #[cfg(feature = "desktop")]
            commands::modem_transfer,
            #[cfg(feature = "desktop")]
            commands::cancel_modem_transfer,
            commands::connect,
            commands::disconnect,
            commands::conn_state,
            commands::send,
            commands::set_log_options,
            commands::set_filters,
            commands::set_color_rules,
            commands::clear_log,
            commands::get_stats,
            commands::set_plot_format,
            commands::set_plot_buffer,
            commands::plot_snapshot,
            commands::set_dtr,
            commands::set_rts,
            commands::set_auto_reconnect,
            commands::start_capture,
            commands::save_capture,
            commands::capture_state,
            commands::close_session,
            commands::save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MAXCOM");
}
