"""端口面板（P4：TP-T02 枚举接入）。

发现串口列表 + 参数配置 + 连接/断开（transport stub，M3 完整接入）。
枚举通过 pyserial list_ports.comports()，替换 T0 占位文本。
"""

from __future__ import annotations

import dearpygui.dearpygui as dpg

from core.transport import SerialConfig, SerialPortInfo, SerialTransport, discover_serial_ports

_BAUDRATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]


class PortManagerPanel:
    """端口管理面板：枚举 + 配置 + 连接。"""

    def __init__(self, parent: int | str) -> None:
        self._parent = parent
        self._transport = SerialTransport()
        self._ports: list[SerialPortInfo] = []
        dpg.add_text("端口 / 连接", parent=parent)
        dpg.add_separator(parent=parent)
        with dpg.group(horizontal=True, parent=parent):
            self._refresh_btn = dpg.add_button(
                label="刷新端口", callback=lambda: self.refresh_ports()
            )
            dpg.add_text("", tag="port_count_lbl")
        self._port_combo = dpg.add_combo([], label="端口", width=-1, parent=parent)
        self._baud_combo = dpg.add_combo(
            [str(b) for b in _BAUDRATES],
            default_value="115200",
            label="波特率",
            width=-1,
            parent=parent,
        )
        self._parity_combo = dpg.add_combo(
            ["none", "even", "odd", "mark", "space"],
            default_value="none",
            label="校验位",
            width=-1,
            parent=parent,
        )
        self._connect_btn = dpg.add_button(
            label="连接", tag="port_connect_btn", callback=self._toggle_connect
        )
        self._status_lbl = dpg.add_text("未连接", parent=parent)
        self.refresh_ports()

    def set_ports(self, ports: list[str]) -> None:
        dpg.configure_item(self._port_combo, items=ports)

    def refresh_ports(self) -> None:
        """枚举当前系统串口，刷新下拉。"""
        self._ports = discover_serial_ports()
        labels = [p.label() for p in self._ports] or ["（未发现串口）"]
        dpg.configure_item(self._port_combo, items=labels)
        if dpg.does_item_exist("port_count_lbl"):
            dpg.set_value("port_count_lbl", f"发现 {len(self._ports)} 个串口")

    @property
    def transport(self) -> SerialTransport:
        return self._transport

    def _toggle_connect(self) -> None:
        if self._transport.is_open():
            self._transport.close()
            dpg.set_item_label("port_connect_btn", "连接")
            dpg.set_value(self._status_lbl, "未连接")
            return
        label = dpg.get_value(self._port_combo)
        if not label or label == "（未发现串口）":
            dpg.set_value(self._status_lbl, "请先选择串口")
            return
        cfg = SerialConfig()
        cfg.port = label.split(" | ")[0]
        cfg.baudrate = int(dpg.get_value(self._baud_combo))
        cfg.parity = dpg.get_value(self._parity_combo)
        try:
            self._transport.open(cfg)
        except ValueError as exc:
            dpg.set_value(self._status_lbl, f"配置错误: {exc}")
            return
        except OSError as exc:
            dpg.set_value(self._status_lbl, f"打开失败: {exc}")
            return
        dpg.set_item_label("port_connect_btn", "断开")
        dpg.set_value(self._status_lbl, f"已连接 {cfg.port} @ {cfg.baudrate}")
