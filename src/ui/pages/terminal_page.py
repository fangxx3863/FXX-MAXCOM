"""终端模式页面（M1 集成）。

从 EventBus 订阅原始流 → AnsiParser.feed → TerminalViewport 渲染。
击键直传：on_key 映射（transport 未实现时丢弃，见 M3）。
页面切换只做路由，不重建引擎（连接保持，ADR-0015/0016）。
"""

from __future__ import annotations

import queue

import dearpygui.dearpygui as dpg

from core.ansi.parser import AnsiParser
from core.pipeline.event_bus import EventBus
from core.terminal.keymap import KeyMapConfig, on_key
from ui.terminal_viewport import TerminalViewport

COLS = 100
ROWS = 32


class TerminalPage:
    """终端页面：交互式终端渲染 + 击键直传。"""

    def __init__(self, parent: int | str, bus: EventBus) -> None:
        self._bus = bus
        self._parser = AnsiParser(rows=ROWS, cols=COLS)
        self._q: queue.Queue[bytes] = bus.subscribe("terminal_page")
        self._keymap = KeyMapConfig()
        with dpg.group(parent=parent):
            self._viewport = TerminalViewport(
                parent, self._parser.buffer, self._parser.scrollback, cols=COLS, rows=ROWS
            )

    def on_raw(self) -> None:
        """从订阅队列拉取原始数据喂给解析器（帧回调中调用）。"""
        while True:
            try:
                data = self._q.get_nowait()
            except queue.Empty:
                break
            self._parser.feed(data)

    def render(self) -> None:
        """每帧重绘：先喂数据再渲染。"""
        self.on_raw()
        self._viewport.render()
        self._viewport.render_cursor(blink_on=True)

    def on_key(self, key: int, modifiers: int) -> None:
        """击键直传：映射为字节流（transport 连接后发送，此处丢弃）。"""
        on_key(key, modifiers, self._keymap)
