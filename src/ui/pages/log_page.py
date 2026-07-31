"""传统收发模式页面（M1 集成）。

LogEngine 从 EventBus 订阅 → 分包/分行/染色/过滤 → LogEntry 增量渲染到列表。
时间戳 + 颜色（Palette 解析段颜色）。过滤隐藏行不显示。
"""

from __future__ import annotations

import dearpygui.dearpygui as dpg

from core.colorize.engine import ColorizeEngine
from core.colorize.palette import Palette
from core.filter.engine import FilterEngine
from core.logview.engine import LogEngine
from core.logview.framing import format_timestamp
from core.logview.splitter import LogEntry
from core.pipeline.encoding import EncodingDetector
from core.pipeline.event_bus import EventBus

# 可见行上限：超出删除最旧（滚动查看交给 M2+ 的虚拟列表/文本框）。
MAX_VISIBLE = 500


class LogPage:
    """传统收发页面：日志列表增量渲染。"""

    def __init__(self, parent: int | str, bus: EventBus, idle_timeout_ms: int = 100) -> None:
        self._parent = parent
        self._palette = Palette("dark")
        self._engine = LogEngine(
            bus, ColorizeEngine(), FilterEngine(), EncodingDetector(), idle_timeout_ms
        )
        self._engine.set_on_entry(self._on_entry)
        self._rows: list[int] = []  # DPG text 行 tag
        self._container = dpg.add_child_window(tag="log_container", parent=parent, border=False)
        self._engine.start()

    def stop(self) -> None:
        self._engine.stop()

    def _on_entry(self, entry: LogEntry) -> None:
        """新日志行：时间戳前缀 + 染色文本，追加渲染。"""
        ts = format_timestamp(entry.timestamp_ms, "relative", base_ms=0)
        color = self._palette.default_fg()
        if entry.segments:
            for seg in entry.segments:
                if seg.fg is not None:
                    color = self._palette.resolve(seg.fg)
                    break
        label = f"{ts} {entry.text}"
        tag = dpg.add_text(label, parent=self._container, color=color)
        self._rows.append(tag)
        if len(self._rows) > MAX_VISIBLE:
            old = self._rows.pop(0)
            if dpg.does_item_exist(old):
                dpg.delete_item(old)
