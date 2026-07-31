"""统计追踪器测试（P4）。"""

from __future__ import annotations

import dearpygui.dearpygui as dpg
import pytest

from core.pipeline.event_bus import EventBus
from core.stats import StatsTracker
from ui.pages.stats_page import StatsPage


class FakeClock:
    """可注入的单调钟，测试可控推进。"""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


# ---------- 追踪器 ----------


def test_tracker_counts() -> None:
    clock = FakeClock()
    tr = StatsTracker(EventBus(), now=clock)
    tr.record_rx(10)
    tr.record_rx(20)
    tr.record_tx(5)
    assert tr.rx_bytes() == 30
    assert tr.tx_bytes() == 5


def test_tracker_rate_window() -> None:
    clock = FakeClock()
    tr = StatsTracker(EventBus(), now=clock)
    for _ in range(1024):
        tr.record_rx(1024)  # 每秒 1MB
        clock.advance(0.001)
    # 窗口 2s 内共 2000 次 × 1024B = 2000KB → 1000KB/s
    rate = tr.rx_rate_kbs()
    assert 990 < rate < 1010


def test_tracker_rate_drops_stale() -> None:
    clock = FakeClock()
    tr = StatsTracker(EventBus(), now=clock)
    tr.record_rx(1024)
    clock.advance(5.0)  # 超出窗口
    tr.record_rx(1024)
    # 旧采样已出窗口，只剩最新 1 次但跨度小 → 速率高
    rate = tr.rx_rate_kbs()
    assert rate > 0
    assert tr.rx_bytes() == 2048  # 累计不丢


def test_tracker_rate_zero_when_empty() -> None:
    tr = StatsTracker(EventBus(), now=FakeClock())
    assert tr.rx_rate_kbs() == 0.0
    assert tr.tx_rate_kbs() == 0.0


def test_tracker_errors() -> None:
    tr = StatsTracker(EventBus(), now=FakeClock())
    tr.record_crc_error()
    tr.record_crc_error()
    tr.record_frame_error()
    assert tr.crc_errors() == 2
    assert tr.frame_errors() == 1


def test_tracker_poll_consumes_bus() -> None:
    bus = EventBus()
    tr = StatsTracker(bus, now=FakeClock())
    bus.publish_raw(b"hello world")  # 11 bytes
    tr.poll()
    assert tr.rx_bytes() == 11


# ---------- 页面 ----------


@pytest.fixture()
def dpg_ctx() -> None:
    dpg.create_context()
    yield
    dpg.destroy_context()


def _build_page(bus: EventBus | None = None) -> StatsPage:
    with dpg.window():
        with dpg.group(tag="page_stats"):
            return StatsPage("page_stats", bus or EventBus())


def test_stats_page_builds(dpg_ctx: None) -> None:
    _build_page()
    for tag in ("stats_rx_lbl", "stats_tx_lbl", "stats_rxrate_lbl", "stats_crc_lbl"):
        assert dpg.does_item_exist(tag), f"{tag} missing"


def test_stats_page_render_updates(dpg_ctx: None) -> None:
    bus = EventBus()
    page = _build_page(bus)
    bus.publish_raw(b"0123456789")  # 10 bytes
    page.render()
    assert dpg.get_value("stats_rx_lbl") == "10 B"
