"""传统收发模式页面（M1 集成 + P2 补全）。

LogEngine 从 EventBus 订阅 → 分包/分行/染色/过滤 → LogEntry 增量渲染到列表。
接收区工具栏：时间戳开关 / 等级过滤 / 暂停 / 清空。
发送面板：输入框 + 发送 + Hex/Text 切换 + 换行符控制（transport stub，M3 接串口）。
等级过滤实现为 FilterEngine 的 show 规则（"INFO"/"WARN"/"ERROR" 白名单）。
"""

from __future__ import annotations

from collections.abc import Callable

import dearpygui.dearpygui as dpg

from app.models.filter_rule import FilterRule
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

# 等级过滤：等级关键词 → show 规则名（白名单）。空值 = 全部显示。
_LEVEL_TAG = {"INFO": "[I]", "WARN": "[W]", "ERROR": "[E]"}


class LogPage:
    """传统收发页面：日志列表增量渲染 + 工具栏 + 发送面板。"""

    def __init__(self, parent: int | str, bus: EventBus, idle_timeout_ms: int = 100) -> None:
        self._parent = parent
        self._palette = Palette("dark")
        self._colorize = ColorizeEngine()
        self._filter = FilterEngine()
        self._show_timestamp = True
        self._paused = False
        self._send_callback: Callable[[bytes], None] | None = None
        self._loop_last_ms = 0
        self._engine = LogEngine(
            bus, self._colorize, self._filter, EncodingDetector(), idle_timeout_ms
        )
        self._engine.set_on_entry(self._on_entry)
        self._rows: list[int] = []  # DPG text 行 tag
        self._build(parent)
        self._engine.start()

    def stop(self) -> None:
        self._engine.stop()

    def set_send_callback(self, callback: Callable[[bytes], None]) -> None:
        """发送回调：文本 → transport 发送（M3 接入）。"""
        self._send_callback = callback

    # ---------- 界面构建 ----------

    def _build(self, parent: int | str) -> None:
        with dpg.group(parent=parent):
            self._build_toolbar()
            # 固定高度日志区：height=0 的 child_window 会吃掉全部剩余高度，
            # 把下方的发送面板挤出可视区域（P1 修复）。
            self._container = dpg.add_child_window(
                tag="log_container", parent=parent, border=False, height=360
            )
            self._build_send_panel()

    def _build_toolbar(self) -> None:
        with dpg.group(horizontal=True, parent=self._parent):
            self._ts_checkbox = dpg.add_checkbox(
                label="时间戳",
                default_value=self._show_timestamp,
                callback=self._on_ts_toggle,
            )
            self._level_combo = dpg.add_combo(
                ["全部", "INFO", "WARN", "ERROR"],
                default_value="全部",
                label="等级过滤",
                width=140,
                callback=self._on_level_filter,
            )
            dpg.add_button(label="暂停", tag="log_pause_btn", callback=self._on_pause)
            dpg.add_button(label="清空", callback=self._on_clear)

    def _build_send_panel(self) -> None:
        with dpg.group(parent=self._parent):
            dpg.add_separator()
            dpg.add_text("发送面板")
            with dpg.group(horizontal=True):
                self._send_input = dpg.add_input_text(
                    hint="发送内容",
                    width=600,
                    on_enter=True,
                    callback=lambda s, a, u: self._send_text(),
                    tag="log_send_input",
                )
                dpg.add_button(label="发送", callback=lambda: self._send_text())
                self._hex_mode = dpg.add_checkbox(label="Hex", default_value=False)
                self._newline_combo = dpg.add_combo(
                    ["无", "\\r\\n", "\\n", "\\r"], default_value="\\r\\n", width=90
                )
            with dpg.group(horizontal=True):
                self._loop_send = dpg.add_checkbox(label="定时循环", default_value=False)
                self._loop_interval = dpg.add_input_int(
                    label="周期(ms)", default_value=1000, width=140, min_value=50, min_clamped=True
                )

    # ---------- 工具栏回调 ----------

    def _on_ts_toggle(self, sender: int, value: bool) -> None:
        self._show_timestamp = value

    def _on_pause(self) -> None:
        self._paused = not self._paused
        dpg.set_item_label("log_pause_btn", "继续" if self._paused else "暂停")

    def _on_clear(self) -> None:
        for tag in self._rows:
            if dpg.does_item_exist(tag):
                dpg.delete_item(tag)
        self._rows.clear()

    def _on_level_filter(self, sender: int, value: str) -> None:
        # 等级过滤：添加/移除对应等级关键词的 show 规则（白名单）
        self._filter.reset()
        if value != "全部":
            tag = _LEVEL_TAG[value]
            self._filter.add_rule(FilterRule(name=f"lv_{value}", pattern=tag, action="show"))

    # ---------- 发送 ----------

    def _build_payload(self, text: str) -> bytes:
        """按 Hex 模式 + 换行符配置组装发送字节。"""
        nl = {
            "\\r\\n": "\r\n",
            "\\n": "\n",
            "\\r": "\r",
            "无": "",
        }[dpg.get_value(self._newline_combo)]
        if bool(dpg.get_value(self._hex_mode)):
            cleaned = text.replace(" ", "")
            return bytes.fromhex(cleaned) if cleaned else b""
        return (text + nl).encode("utf-8", errors="replace")

    def _send_text(self) -> None:
        text = dpg.get_value(self._send_input)
        if not text:
            return
        self._send(self._build_payload(text))
        dpg.set_value(self._send_input, "")

    def _send(self, data: bytes) -> None:
        if self._send_callback is not None:
            self._send_callback(data)
        # transport 未接入（M3）：发送内容回显到日志区，便于演示验收
        if data:
            self._engine.on_data(data)

    def tick(self, now_ms: int) -> None:
        """帧回调：定时循环发送（勾选后按周期重发输入框内容）。"""
        if not dpg.get_value(self._loop_send):
            return
        interval = max(50, int(dpg.get_value(self._loop_interval)))
        if now_ms - self._loop_last_ms >= interval:
            self._loop_last_ms = now_ms
            text = dpg.get_value(self._send_input)
            if text:
                self._send(self._build_payload(text))

    # ---------- 渲染 ----------

    def _on_entry(self, entry: LogEntry) -> None:
        """新日志行：时间戳前缀 + 染色文本，追加渲染。"""
        if self._paused:
            return
        color = self._palette.default_fg()
        text = entry.text
        if entry.segments:
            # 以染色段为准：ANSI 行已被剥离控制码（让位 INV-1），颜色取自首个有色段
            text = "".join(s.text for s in entry.segments)
            for seg in entry.segments:
                if seg.fg is not None:
                    color = self._palette.resolve(seg.fg)
                    break
        prefix = ""
        if self._show_timestamp:
            prefix = f"{format_timestamp(entry.timestamp_ms, 'relative', base_ms=0)} "
        label = f"{prefix}{text}"
        tag = dpg.add_text(label, parent=self._container, color=color)
        self._rows.append(tag)
        if len(self._rows) > MAX_VISIBLE:
            old = self._rows.pop(0)
            if dpg.does_item_exist(old):
                dpg.delete_item(old)
