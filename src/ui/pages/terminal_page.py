"""终端模式页面（M1 集成 + P3 增强）。

从 EventBus 订阅原始流 → AnsiParser.feed → TerminalViewport 渲染。
击键直传：add_key_press_handler 捕获键盘 → on_key 映射 → 发送回调（transport stub）。
底部状态栏：模式 / 编码 / RX / TX 计数。
页面切换只做路由，不重建引擎（连接保持，ADR-0015/0016）。
"""

from __future__ import annotations

import queue
from collections.abc import Callable

import dearpygui.dearpygui as dpg

from core.ansi.parser import AnsiParser
from core.pipeline.event_bus import EventBus
from core.terminal.keymap import MOD_ALT, MOD_CTRL, MOD_SHIFT, KeyMapConfig, on_key
from ui.terminal_viewport import TerminalViewport

COLS = 100
ROWS = 32


class TerminalPage:
    """终端页面：交互式终端渲染 + 击键直传 + 状态栏。"""

    def __init__(self, parent: int | str, bus: EventBus) -> None:
        self._bus = bus
        self._parser = AnsiParser(rows=ROWS, cols=COLS)
        self._q: queue.Queue[bytes] = bus.subscribe("terminal_page")
        self._keymap = KeyMapConfig()
        self._rx_bytes = 0
        self._tx_bytes = 0
        self._send_callback: Callable[[bytes], None] | None = None
        with dpg.group(parent=parent):
            self._viewport = TerminalViewport(
                parent, self._parser.buffer, self._parser.scrollback, cols=COLS, rows=ROWS
            )
            self._build_status_bar()
        with dpg.handler_registry():
            dpg.add_key_press_handler(callback=self._on_key_event)

    def _build_status_bar(self) -> None:
        with dpg.group(horizontal=True, tag="term_status"):
            dpg.add_text("[终端模式]", tag="term_mode_lbl")
            dpg.add_text("ENCODING: UTF-8", tag="term_enc_lbl")
            dpg.add_text("RX: 0 B", tag="term_rx_lbl")
            dpg.add_text("TX: 0 B", tag="term_tx_lbl")

    def set_send_callback(self, callback: Callable[[bytes], None]) -> None:
        """击键直传回调：字节 → transport 发送（M3 接入）。"""
        self._send_callback = callback

    def on_raw(self) -> None:
        """从订阅队列拉取原始数据喂给解析器（帧回调中调用）。"""
        while True:
            try:
                data = self._q.get_nowait()
            except queue.Empty:
                break
            self._parser.feed(data)
            self._rx_bytes += len(data)

    def render(self) -> None:
        """每帧重绘：先喂数据再渲染 + 状态栏刷新。"""
        self.on_raw()
        self._viewport.render()
        self._viewport.render_cursor(blink_on=True)
        self._update_status()

    def _on_key_event(self, sender: int, app_data: int) -> None:
        """DPG key press handler：app_data = 按键 key id；修饰键经 is_key_down 查询。"""
        modifiers = 0
        if dpg.is_key_down(dpg.mvKey_ModCtrl):
            modifiers |= MOD_CTRL
        if dpg.is_key_down(dpg.mvKey_ModShift):
            modifiers |= MOD_SHIFT
        if dpg.is_key_down(dpg.mvKey_ModAlt):
            modifiers |= MOD_ALT
        data = on_key(app_data, modifiers, self._keymap)
        if data:
            self._tx_bytes += len(data)
            if self._send_callback is not None:
                self._send_callback(data)
            self._update_status()

    def _update_status(self) -> None:
        if dpg.does_item_exist("term_rx_lbl"):
            dpg.set_value("term_rx_lbl", f"RX: {self._rx_bytes} B")
        if dpg.does_item_exist("term_tx_lbl"):
            dpg.set_value("term_tx_lbl", f"TX: {self._tx_bytes} B")
