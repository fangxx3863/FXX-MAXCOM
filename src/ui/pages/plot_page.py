"""绘图页面（P4 基础 + P3 通道控制）。

从 EventBus 订阅原始字节流，解析 ASCII 数值（如 "ch1:1.5 ch2:3.2"），
写入每通道环形缓冲，波形通道增量渲染。
通道控制：可见性复选框 / 颜色 / 缓冲上限 / 清空波形。完整帧解析为 M2。
"""

from __future__ import annotations

import queue
import re

import dearpygui.dearpygui as dpg

from core.pipeline.event_bus import EventBus

# 通道数 + 可见历史点数
CHANNEL_COUNT = 4
DEFAULT_MAX_POINTS = 512

# 每行形如 "ch1:12.5 ch2:-3.2 ..."（序号 1..4）
_ROW_RE = re.compile(rb"ch([1-4]):(-?\d+\.?\d*(?:[eE][+-]?\d+)?)")


class WaveformChannel:
    """单通道环形缓冲 + 波形数据。"""

    def __init__(self, name: str, max_points: int = DEFAULT_MAX_POINTS) -> None:
        self.name = name
        self._values: list[float] = []
        self._max = max_points

    def append(self, value: float) -> None:
        self._values.append(value)
        if len(self._values) > self._max:
            del self._values[: len(self._values) - self._max]

    def clear(self) -> None:
        self._values.clear()

    def set_max_points(self, n: int) -> None:
        self._max = max(16, n)
        if len(self._values) > self._max:
            del self._values[: len(self._values) - self._max]

    def data(self) -> tuple[list[float], list[float]]:
        n = len(self._values)
        return (list(range(n)), self._values.copy())


def parse_samples(data: bytes) -> list[tuple[int, float]]:
    """解析原始字节流中的通道采样：(通道序号1..4, 数值)。非匹配返回 []。"""
    out: list[tuple[int, float]] = []
    for line in data.splitlines():
        for m in _ROW_RE.finditer(line):
            out.append((int(m.group(1)), float(m.group(2))))
    return out


class PlotPage:
    """绘图页面：多通道波形 + 控制区。"""

    def __init__(self, parent: int | str, bus: EventBus) -> None:
        self._bus = bus
        self._q: queue.Queue[bytes] = bus.subscribe("plot_page")
        self._channels = [WaveformChannel(f"ch{i}") for i in range(1, CHANNEL_COUNT + 1)]
        self._series_tags: list[str] = []
        with dpg.group(parent=parent):
            dpg.add_text("绘图")
            dpg.add_separator()
            self._build_controls()
            self._build_plot()

    def _build_controls(self) -> None:
        with dpg.group(horizontal=True):
            dpg.add_text("通道")
            self._chk: list[int] = []
            for i in range(CHANNEL_COUNT):
                tag = f"plot_chk_{i + 1}"
                cb = dpg.add_checkbox(
                    label=f"ch{i + 1}",
                    default_value=True,
                    callback=self._on_visibility,
                    user_data=i + 1,
                    tag=tag,
                )
                self._chk.append(cb)
        with dpg.group(horizontal=True):
            dpg.add_text("缓冲点数")
            self._max_pts = dpg.add_input_int(
                default_value=DEFAULT_MAX_POINTS,
                width=100,
                min_value=16,
                min_clamped=True,
                callback=lambda s, a, u: self._on_max_points(a),
            )
            dpg.add_button(label="清空波形", callback=self._on_clear)
            dpg.add_text("数据格式: Simple ASCII", tag="plot_format_lbl")

    def _build_plot(self) -> None:
        with dpg.plot(label="波形", width=-1, height=360, tag="plot_waveform"):
            dpg.add_plot_legend()
            with dpg.plot_axis(dpg.mvXAxis, label="样本", tag="plot_x"):
                pass
            with dpg.plot_axis(dpg.mvYAxis, label="值", tag="plot_y"):
                self._series_tags = []
                for i in range(CHANNEL_COUNT):
                    tag = f"plot_series_ch{i + 1}"
                    self._series_tags.append(
                        dpg.add_line_series([], [], label=f"ch{i + 1}", tag=tag)
                    )

    def _on_visibility(self, sender: int, value: bool, user_data: int) -> None:
        tag = f"plot_series_ch{user_data}"
        if dpg.does_item_exist(tag):
            dpg.configure_item(tag, show=value)

    def _on_max_points(self, value: int) -> None:
        for ch in self._channels:
            ch.set_max_points(value)

    def _on_clear(self) -> None:
        for ch in self._channels:
            ch.clear()
        for tag in self._series_tags:
            if dpg.does_item_exist(tag):
                dpg.set_value(tag, [[], []])

    def on_raw(self) -> None:
        """从订阅队列拉取原始流解析采样。"""
        while True:
            try:
                data = self._q.get_nowait()
            except queue.Empty:
                break
            for idx, value in parse_samples(data):
                self._channels[idx - 1].append(value)

    def render(self) -> None:
        self.on_raw()
        for i, ch in enumerate(self._channels):
            tag = f"plot_series_ch{i + 1}"
            if dpg.does_item_exist(tag):
                dpg.set_value(tag, ch.data())
