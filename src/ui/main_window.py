"""主窗口 + 布局骨架（T0-T07）+ M1 双模式集成。

侧边导航（端口/终端/收发/绘图/统计/设置）+ 页面路由 + 底部状态栏。
页面切换只是显示切换，不涉及任何引擎（连接保持，ADR-0015）。
M1：终端模式（TerminalPage）+ 传统模式（LogPage）接入，共享帧回调增量渲染。
"""

from __future__ import annotations

from collections.abc import Callable

import dearpygui.dearpygui as dpg

from app.app_context import AppContext
from ui import theme
from ui.fonts import register_fonts
from ui.pages.log_page import LogPage
from ui.pages.plot_page import PlotPage
from ui.pages.stats_page import StatsPage
from ui.pages.terminal_page import TerminalPage
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
        self._terminal_page: TerminalPage | None = None
        self._log_page: LogPage | None = None
        self._plot_page: PlotPage | None = None
        self._stats_page: StatsPage | None = None

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
                    with dpg.group(tag="page_port"):
                        self._port_panel = PortManagerPanel(parent="page_port")
                    with dpg.group(tag="page_terminal"):
                        self._terminal_page = TerminalPage("page_terminal", self._app.event_bus)
                    with dpg.group(tag="page_log"):
                        self._log_page = LogPage("page_log", self._app.event_bus)
                    with dpg.group(tag="page_plot"):
                        self._plot_page = PlotPage("page_plot", self._app.event_bus)
                    with dpg.group(tag="page_stats"):
                        self._stats_page = StatsPage("page_stats", self._app.event_bus)
                    self.status_bar = StatusBar(parent="content_panel")

        self._port_panel.set_state_callback(self.status_bar.update)
        # TX 路径接入统计：收发/终端页发送字节 → stats.record_tx(len(data))
        if self._log_page is not None and self._stats_page is not None:
            stats = self._stats_page.stats
            self._log_page.set_send_callback(lambda data: stats.record_tx(len(data)))
        if self._terminal_page is not None and self._stats_page is not None:
            stats = self._stats_page.stats
            self._terminal_page.set_send_callback(lambda data: stats.record_tx(len(data)))

        # 初始只显示端口页；其余页隐藏（路由切换时显示）
        for page in ("terminal", "log", "plot", "stats"):
            dpg.hide_item(self._page_group(page))
        dpg.set_primary_window("main_window", True)

    def _page_group(self, page: str) -> str:
        return f"page_{page}"

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
        # 路由：显示目标页，隐藏其余已构建页（连接/引擎保持，ADR-0015/0016）
        for key in ("port", "terminal", "log", "plot", "stats"):
            grp = self._page_group(key)
            if key == page:
                dpg.show_item(grp)
            else:
                dpg.hide_item(grp)
        # 业务模块注册的 callback 在此触发（T0 后接入）
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
        dpg.set_frame_callback(1, self._frame_callback)
        dpg.show_viewport()
        dpg.start_dearpygui()
        if self._log_page is not None:
            self._log_page.stop()
        dpg.destroy_context()

    def _frame_callback(self) -> None:
        """每帧：终端/绘图/统计页喂数据 + 重绘；日志页引擎后台线程已消费，仅驱动定时发送。"""
        if self._terminal_page is not None:
            self._terminal_page.render()
        if self._plot_page is not None:
            self._plot_page.render()
        if self._stats_page is not None:
            self._stats_page.render()
        if self._log_page is not None:
            now_ms = int(dpg.get_total_time() * 1000)
            self._log_page.tick(now_ms)
