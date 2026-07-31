"""主窗口冒烟测试（T0-T07）。

只验证构建逻辑与页面路由（不启动渲染循环——headless 环境无法渲染）。
"""

import dearpygui.dearpygui as dpg
import pytest

from app.app_context import AppContext
from ui import theme
from ui.main_window import PAGES, MainWindow


@pytest.fixture()
def dpg_ctx() -> None:
    dpg.create_context()
    yield
    dpg.destroy_context()


def build_window() -> MainWindow:
    window = MainWindow(AppContext())
    window._build()
    return window


def test_pages_defined() -> None:
    assert set(PAGES) == {"port", "terminal", "log", "plot", "stats", "settings"}


def test_nav_buttons_exist(dpg_ctx: None) -> None:
    build_window()
    for key in PAGES:
        assert dpg.does_item_exist(f"nav_{key}"), f"nav_{key} missing"


def test_show_page_switches_current(dpg_ctx: None) -> None:
    window = build_window()
    assert window._current_page == "port"
    window.show_page("plot")
    assert window._current_page == "plot"
    window.show_page("settings")
    assert window._current_page == "settings"


def test_show_page_invalid_ignored(dpg_ctx: None) -> None:
    window = build_window()
    window.show_page("nope")
    assert window._current_page == "port"


def test_nav_toggle_collapses(dpg_ctx: None) -> None:
    window = build_window()
    before = dpg.get_item_configuration("nav_panel")["width"]
    window._toggle_nav()
    after = dpg.get_item_configuration("nav_panel")["width"]
    assert after < before


def test_register_page_callback(dpg_ctx: None) -> None:
    window = build_window()
    calls: list[str] = []
    window.register_page_callback("terminal", lambda: calls.append("terminal"))
    window.show_page("terminal")
    assert calls == ["terminal"]


def test_theme_colors_defined() -> None:
    assert len(theme.BG) == 3
    assert len(theme.ACCENT) == 3


def test_status_bar_updates(dpg_ctx: None) -> None:
    window = build_window()
    window.status_bar.update(connected=True, port="COM3", baudrate=115200)
    assert dpg.get_value("status_label") == "已连接"
    assert dpg.get_value("status_detail") == "COM3 | 115200 baud"

    window.status_bar.update(connected=False)
    assert dpg.get_value("status_label") == "未连接"
    assert dpg.get_value("status_detail") == "COM-- | 115200 baud"
