"""绘图页面（P4：add_plot 基础通道）。

从 EventBus 订阅原始字节流，解析 ASCII 数值（demo 数据源发形如
"v:12.5\n" 的采样），写入环形缓冲，波形通道增量渲染。
PLT-T01（数据源 + 环形缓冲）基础版；完整帧解析为 M2。
"""

from __future__ import annotations

import queue
import re

import dearpygui.dearpygui as dpg

from core.pipeline.event_bus import EventBus

# 可见历史点数
MAX_POINTS = 512

# ASCII 数值采样："key:12.5" 或 "12.5" 一行（只取捕获组 = 数值本身）
_NUM_RE = re.compile(rb"(?:^|[\s:])(-?\d+\.?\d*(?:[eE][+-]?\d+)?)")
# 过滤行前缀（demo 采样形如 "ch:3.14"）
_PREFIX = b"ch:"


class WaveformChannel:
    """单通道环形缓冲 + add_plot 波形渲染。"""

    def __init__(self, name: str, max_points: int = MAX_POINTS) -> None:
        self.name = name
        self._values: list[float] = []
        self._max = max_points

    def append(self, value: float) -> None:
        self._values.append(value)
        if len(self._values) > self._max:
            del self._values[: len(self._values) - self._max]

    def data(self) -> tuple[list[float], list[float]]:
        n = len(self._values)
        return (list(range(n)), self._values.copy())


def parse_samples(data: bytes, prefix: bytes = _PREFIX) -> list[float]:
    """从原始字节流解析数值采样；非 ASCII 文本/无匹配返回 []。"""
    if prefix and prefix not in data:
        return []
    out: list[float] = []
    for line in data.splitlines():
        m = _NUM_RE.search(line)
        if m:
            out.append(float(m.group(1)))
    return out


class PlotPage:
    """绘图页面：add_plot 波形通道 + 状态行。"""

    def __init__(self, parent: int | str, bus: EventBus) -> None:
        self._bus = bus
        self._q: queue.Queue[bytes] = bus.subscribe("plot_page")
        self._channel = WaveformChannel("ch")
        with dpg.group(parent=parent):
            dpg.add_text("绘图", parent=parent)
            dpg.add_separator(parent=parent)
            self._build_plot()

    def _build_plot(self) -> None:
        with dpg.plot(label="波形", width=-1, height=360, tag="plot_waveform"):
            dpg.add_plot_legend()
            with dpg.plot_axis(dpg.mvXAxis, label="样本", tag="plot_x"):
                pass
            with dpg.plot_axis(dpg.mvYAxis, label="值", tag="plot_y"):
                self._series = dpg.add_line_series([], [], label="ch", tag="plot_series_ch")

    def on_raw(self) -> None:
        """从订阅队列拉取原始流解析采样。"""
        while True:
            try:
                data = self._q.get_nowait()
            except queue.Empty:
                break
            for v in parse_samples(data):
                self._channel.append(v)

    def render(self) -> None:
        self.on_raw()
        xs, ys = self._channel.data()
        if dpg.does_item_exist("plot_series_ch"):
            dpg.set_value("plot_series_ch", [xs, ys])
