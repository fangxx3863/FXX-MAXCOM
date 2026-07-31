"""端口面板（T0-T07 空壳，TP 模块填充）。

T0 阶段仅占位；串口枚举/连接由 transport 模块实现。
"""

from __future__ import annotations

import dearpygui.dearpygui as dpg


class PortManagerPanel:
    """端口管理面板（空壳）。"""

    def __init__(self, parent: int | str) -> None:
        dpg.add_text("端口 / 连接", parent=parent)
        dpg.add_separator(parent=parent)
        self._port_combo = dpg.add_combo([], label="端口", parent=parent)
        dpg.add_text("（T0 空壳：连接功能见 transport 模块）", parent=parent)

    def set_ports(self, ports: list[str]) -> None:
        dpg.configure_item(self._port_combo, items=ports)
