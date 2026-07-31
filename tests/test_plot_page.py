"""绘图页面基础通道测试（P4：PLT-T01 子集）。"""

from __future__ import annotations

import dearpygui.dearpygui as dpg
import pytest

from core.pipeline.event_bus import EventBus
from ui.pages.plot_page import PlotPage, WaveformChannel, parse_samples


@pytest.fixture()
def dpg_ctx() -> None:
    dpg.create_context()
    yield
    dpg.destroy_context()


# ---------- 采样解析 ----------


def test_parse_samples_prefix() -> None:
    assert parse_samples(b"ch:3.14\n") == [3.14]
    assert parse_samples(b"ch:-1.5\nch:2\n") == [-1.5, 2.0]


def test_parse_samples_no_prefix_returns_empty() -> None:
    assert parse_samples(b"hello 3.14\n") == []


def test_parse_samples_empty() -> None:
    assert parse_samples(b"") == []
    assert parse_samples(b"no numbers here\n") == []


def test_parse_samples_sci_notation() -> None:
    assert parse_samples(b"ch:1e3\n") == [1000.0]


# ---------- 环形缓冲 ----------


def test_waveform_channel_append() -> None:
    ch = WaveformChannel("ch", max_points=4)
    for v in range(6):
        ch.append(float(v))
    _, ys = ch.data()
    assert ys == [2.0, 3.0, 4.0, 5.0]  # 只保留最后 4 点


def test_waveform_channel_empty() -> None:
    ch = WaveformChannel("ch")
    xs, ys = ch.data()
    assert xs == []
    assert ys == []


# ---------- 页面 ----------


def _build_page(bus: EventBus | None = None) -> PlotPage:
    with dpg.window():
        with dpg.group(tag="page_plot"):
            return PlotPage("page_plot", bus or EventBus())


def test_plot_page_builds(dpg_ctx: None) -> None:
    _build_page()
    assert dpg.does_item_exist("plot_waveform")
    assert dpg.does_item_exist("plot_series_ch")


def test_plot_page_consumes_stream(dpg_ctx: None) -> None:
    bus = EventBus()
    page = _build_page(bus)
    bus.publish_raw(b"ch:1\nch:2\n")
    page.render()
    _, ys = page._channel.data()
    assert ys == [1.0, 2.0]


def test_plot_page_ignores_non_sample(dpg_ctx: None) -> None:
    bus = EventBus()
    page = _build_page(bus)
    bus.publish_raw(b"[I] system boot ok\r\n")
    page.render()
    assert page._channel.data()[1] == []
