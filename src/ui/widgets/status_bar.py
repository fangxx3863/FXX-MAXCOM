"""底部状态栏（T0-T07 空壳）。

T0 阶段显示占位连接信息；真实状态由 TP 模块接入。
"""

from __future__ import annotations

import dearpygui.dearpygui as dpg

from ui import theme


class StatusBar:
    """状态栏：连接状态 + 端口/波特率 + 指示点。"""

    def __init__(self, parent: int | str) -> None:
        with dpg.group(horizontal=True, parent=parent):
            self._led = dpg.add_drawlist(width=14, height=14)
            dpg.draw_circle(
                (7, 7),
                radius=5,
                fill=theme.ERROR,
                parent=self._led,
                tag="status_led",
            )
            self._label = dpg.add_text("未连接", tag="status_label")
            dpg.add_text("COM-- | 115200 baud", tag="status_detail")

    def update(self, connected: bool, port: str = "", baudrate: int | None = None) -> None:
        dpg.configure_item("status_led", fill=theme.SUCCESS if connected else theme.ERROR)
        dpg.set_value("status_label", "已连接" if connected else "未连接")
        detail = f"{port} | {baudrate} baud" if connected and baudrate else "COM-- | 115200 baud"
        dpg.set_value("status_detail", detail)

    def set_status(self, text: str) -> None:
        dpg.set_value("status_label", text)
