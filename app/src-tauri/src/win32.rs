//! Windows 平台窗口增强。
//!
//! 两件事：
//! 1. 补齐标准窗口样式，修复「爆炸视图下最小化 → 休眠唤醒 → 任务栏点不回来」；
//! 2. 让自绘标题栏的窗口按钮参与系统命中测试，从而触发 Windows 11 原生
//!    的 Snap Layout（贴靠布局）悬浮面板。
//!
//! 第 2 点的关键前提是 WebView2 的「非客户区支持」：
//! WebView2 默认把整个客户区都当成普通网页，`WM_NCHITTEST` 由它自己返回
//! `HTCLIENT`，宿主窗口根本没有机会参与命中测试。只有开启
//! `IsNonClientRegionSupportEnabled` 之后，网页中标记为 `app-region: drag`
//! 的区域才会被当作非客户区交还给宿主窗口处理，我们在 `WM_NCHITTEST` 里
//! 返回 `HTMAXBUTTON`，Windows 才会弹出 Snap Layout。

use tauri::{AppHandle, Manager, Runtime};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings9;
use windows::core::Interface;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
    DWMWCP_ROUND,
};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Controls::MARGINS;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowLongW, IsIconic, SetWindowLongW, SetWindowPos, GWL_STYLE, HTCLOSE,
    HTMAXBUTTON, HTMINBUTTON, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, SWP_FRAMECHANGED,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_NCHITTEST, WM_POWERBROADCAST, WS_CAPTION,
    WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
};

const SUBCLASS_ID: usize = 0x4D415843; // 'MAXC'

// 与 app/src/styles.css 中 #win-controls button 的尺寸保持一致（逻辑像素）。
const CAPTION_BUTTON_WIDTH: f32 = 44.0;
const CAPTION_BUTTON_HEIGHT: f32 = 38.0;

pub fn setup_win32_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let webview = window.clone();
    if let Err(err) = webview.with_webview(|platform_webview| unsafe {
        let controller = platform_webview.controller();
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        // 只在 WebView2 Runtime 支持该接口时开启，旧运行时静默降级。
        if let Ok(settings9) = settings.cast::<ICoreWebView2Settings9>() {
            let _ = settings9.SetIsNonClientRegionSupportEnabled(true);
        }
    }) {
        log::warn!("开启 WebView2 非客户区支持失败：{err}");
    }

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        // 补齐标准窗口样式。任务栏的「还原」、系统菜单、休眠唤醒恢复都依赖它们。
        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        let required = WS_CAPTION.0
            | WS_THICKFRAME.0
            | WS_MINIMIZEBOX.0
            | WS_MAXIMIZEBOX.0
            | WS_SYSMENU.0;
        if style & required != required {
            let _ = SetWindowLongW(hwnd, GWL_STYLE, (style | required) as i32);
        }

        // Win11 圆角 + 顶部 1px DWM 边框，保留无边框窗口的阴影与圆角。
        let corner = DWMWCP_ROUND.0;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner as *const _ as *const _,
            std::mem::size_of_val(&corner) as u32,
        );
        let margins = MARGINS {
            cxLeftWidth: 0,
            cxRightWidth: 0,
            cyTopHeight: 1,
            cyBottomHeight: 0,
        };
        let _ = DwmExtendFrameIntoClientArea(hwnd, &margins);
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        );

        let _ = SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, 0);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CaptionButton {
    Minimize,
    Maximize,
    Close,
}

/// 判断客户区坐标 (x, y) 落在右上角哪个窗口控制按钮上。
/// 顺序自右向左：关闭、最大化/还原、最小化。
unsafe fn caption_button_at(hwnd: HWND, x: i32, y: i32) -> Option<CaptionButton> {
    let mut rect = RECT::default();
    if GetClientRect(hwnd, &mut rect).is_err() {
        return None;
    }

    let dpi = GetDpiForWindow(hwnd);
    let scale = if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 };
    let height = (CAPTION_BUTTON_HEIGHT * scale).round() as i32;
    let width = (CAPTION_BUTTON_WIDTH * scale).round() as i32;
    if width <= 0 || y < 0 || y >= height {
        return None;
    }

    let from_right = (rect.right - rect.left) - x;
    if from_right < 0 {
        None
    } else if from_right < width {
        Some(CaptionButton::Close)
    } else if from_right < width * 2 {
        Some(CaptionButton::Maximize)
    } else if from_right < width * 3 {
        Some(CaptionButton::Minimize)
    } else {
        None
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    match msg {
        // 自绘标题栏：把窗口按钮区域报成标准非客户区命中代码。
        // 返回 HTMAXBUTTON 后，Windows 11 会在鼠标悬停时弹出 Snap Layout，
        // 而最小化 / 最大化 / 关闭的点击行为交给 DefWindowProc 按系统语义处理。
        WM_NCHITTEST => {
            let mut point = POINT {
                x: (lparam.0 as i16) as i32,
                y: ((lparam.0 >> 16) as i16) as i32,
            };
            if ScreenToClient(hwnd, &mut point).as_bool() {
                if let Some(button) = caption_button_at(hwnd, point.x, point.y) {
                    let code = match button {
                        CaptionButton::Minimize => HTMINBUTTON,
                        CaptionButton::Maximize => HTMAXBUTTON,
                        CaptionButton::Close => HTCLOSE,
                    };
                    return LRESULT(code as isize);
                }
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }

        // 休眠 / 挂起唤醒后重新应用框架变更，保证窗口仍能被任务栏正常唤起。
        WM_POWERBROADCAST
            if matches!(
                wparam.0 as u32,
                PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND
            ) =>
        {
            if !IsIconic(hwnd).as_bool() {
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
                );
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }

        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}