"""主窗口 + 布局骨架（T0-T07）。

侧边导航（端口/终端/收发/绘图/统计/设置）+ 页面路由 + 底部状态栏。
页面切换只是显示切换，不涉及任何引擎（连接保持，ADR-0015）。
"""

from __future__ import annotations

from collections.abc import Callable

import dearpygui.dearpygui as dpg

from app.app_context import AppContext
from ui import theme
from ui.fonts import register_fonts
from ui.widgets.port_manager import PortManagerPanel
from ui.widgets.status_bar import StatusBar

PAGES: dict[str, str] = {
    "port": "端口",
    "terminal": "终端",
    "log": "收发",
    "plot": "绘图",
    "stats": "统计",
    "settings": "设置",
}


class MainWindow:
    """MAXCOM 主窗口：侧边导航 + 页面路由 + 状态栏。"""

    def __init__(self, app_context: AppContext) -> None:
        self._app = app_context
        self._current_page: str = "port"
        self._nav_collapsed = False
        self._page_callbacks: dict[str, Callable[[], None]] = {}

    def register_page_callback(self, page: str, callback: Callable[[], None]) -> None:
        """供业务模块注入页面构建函数（T0 后由各模块接入）。"""
        self._page_callbacks[page] = callback

    def _build(self) -> None:
        dpg.create_context()
        register_fonts()  # CJK 默认字体（无中文字形 → ???）；必须在 create_viewport 前

        with dpg.theme() as global_theme:
            with dpg.theme_component(dpg.mvAll):
                dpg.add_theme_color(dpg.mvThemeCol_WindowBg, theme.BG, category=dpg.mvThemeCat_Core)
                dpg.add_theme_color(
                    dpg.mvThemeCol_ChildBg, theme.BG_PANEL, category=dpg.mvThemeCat_Core
                )
                dpg.add_theme_color(dpg.mvThemeCol_Text, theme.TEXT, category=dpg.mvThemeCat_Core)
        dpg.bind_theme(global_theme)

        with dpg.window(tag="main_window", no_title_bar=True, width=1280, height=800):
            with dpg.group(horizontal=True):
                with dpg.child_window(tag="nav_panel", width=160, border=False):
                    dpg.add_text("MAXCOM", color=theme.ACCENT)
                    dpg.add_separator()
                    for key, title in PAGES.items():
                        dpg.add_button(
                            label=title,
                            tag=f"nav_{key}",
                            width=-1,
                            callback=lambda s, a, u: self.show_page(u),
                            user_data=key,
                        )
                    dpg.add_separator()
                    dpg.add_button(
                        label="折叠",
                        tag="nav_toggle",
                        width=-1,
                        callback=self._toggle_nav,
                    )
                with dpg.child_window(tag="content_panel", border=False):
                    self._port_panel = PortManagerPanel(parent="content_panel")
                    self.status_bar = StatusBar(parent="content_panel")

        dpg.set_primary_window("main_window", True)

    def show_page(self, page: str) -> None:
        if page not in PAGES:
            return
        self._current_page = page
        # 高亮当前导航项：DPG 按钮无 text_color，改用专用 theme
        for key in PAGES:
            btn = f"nav_{key}"
            if key == page:
                with dpg.theme() as active_theme:
                    with dpg.theme_component(dpg.mvButton):
                        dpg.add_theme_color(
                            dpg.mvThemeCol_Text, theme.ACCENT, category=dpg.mvThemeCat_Core
                        )
                dpg.bind_item_theme(btn, active_theme)
            else:
                dpg.bind_item_theme(btn, 0)
        # 页面切换只做路由通知；业务模块注册的 callback 在此触发（T0 后接入）
        cb = self._page_callbacks.get(page)
        if cb:
            cb()

    def _toggle_nav(self) -> None:
        self._nav_collapsed = not self._nav_collapsed
        width = 40 if self._nav_collapsed else 160
        dpg.configure_item("nav_panel", width=width)

    def run(self) -> None:
        """启动 DPG 渲染循环（阻塞）。"""
        self._build()
        dpg.create_viewport(title="MAXCOM", width=1280, height=800)
        dpg.setup_dearpygui()
        dpg.show_viewport()
        dpg.start_dearpygui()
        dpg.destroy_context()
