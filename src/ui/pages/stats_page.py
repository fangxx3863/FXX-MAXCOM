"""统计页面（P4：基础统计卡片）。

累计 RX/TX 字节 + 实时速率（KB/s）+ 错误帧计数，帧回调刷新。
TX 由收发/终端页发送路径经 StatsTracker.record_tx 上报。
"""

from __future__ import annotations

import dearpygui.dearpygui as dpg

from core.pipeline.event_bus import EventBus
from core.stats import StatsTracker
from ui import theme


class StatsPage:
    """统计页面：四张基础卡片 + 状态行。"""

    def __init__(self, parent: int | str, bus: EventBus) -> None:
        self._parent = parent
        self._stats = StatsTracker(bus)
        with dpg.group(parent=parent):
            dpg.add_text("统计")
            dpg.add_separator()
            self._build_cards()

    def _card(self, label: str, tag: str) -> None:
        dpg.add_text(label, color=theme.TEXT_DIM)
        dpg.add_text("0", tag=tag, color=theme.ACCENT)

    def _build_cards(self) -> None:
        with dpg.group(horizontal=True):
            with dpg.group(width=180):
                self._card("累计接收 (RX)", "stats_rx_lbl")
            with dpg.group(width=180):
                self._card("累计发送 (TX)", "stats_tx_lbl")
            with dpg.group(width=180):
                self._card("RX 速率 (KB/s)", "stats_rxrate_lbl")
            with dpg.group(width=180):
                self._card("TX 速率 (KB/s)", "stats_txrate_lbl")
        dpg.add_separator()
        with dpg.group(horizontal=True):
            with dpg.group(width=180):
                self._card("CRC 错误", "stats_crc_lbl")
            with dpg.group(width=180):
                self._card("帧错误", "stats_frame_lbl")

    @property
    def stats(self) -> StatsTracker:
        return self._stats

    def render(self) -> None:
        """帧回调：消费 RX 数据 + 刷新卡片。"""
        self._stats.poll()
        if not dpg.does_item_exist("stats_rx_lbl"):
            return
        dpg.set_value("stats_rx_lbl", f"{self._stats.rx_bytes()} B")
        dpg.set_value("stats_tx_lbl", f"{self._stats.tx_bytes()} B")
        dpg.set_value("stats_rxrate_lbl", f"{self._stats.rx_rate_kbs():.2f}")
        dpg.set_value("stats_txrate_lbl", f"{self._stats.tx_rate_kbs():.2f}")
        dpg.set_value("stats_crc_lbl", f"{self._stats.crc_errors()}")
        dpg.set_value("stats_frame_lbl", f"{self._stats.frame_errors()}")
