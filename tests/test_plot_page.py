"""绘图页面基础通道测试（P4/P3：PLT-T01 子集 + 多通道控制）。"""

from __future__ import annotations

import dearpygui.dearpygui as dpg
import pytest

from core.pipeline.event_bus import EventBus
from ui.pages.plot_page import CHANNEL_COUNT, PlotPage, WaveformChannel, parse_samples


@pytest.fixture()
def dpg_ctx() -> None:
    dpg.create_context()
    yield
    dpg.destroy_context()


# ---------- 采样解析 ----------


def test_parse_samples_multi_channel() -> None:
    assert parse_samples(b"ch1:3.14 ch2:-1.5\n") == [(1, 3.14), (2, -1.5)]


def test_parse_samples_out_of_range_channel_ignored() -> None:
    assert parse_samples(b"ch9:1.0\n") == []


def test_parse_samples_empty() -> None:
    assert parse_samples(b"") == []
    assert parse_samples(b"no samples here\n") == []
    assert parse_samples(b"[I] system boot ok\r\n") == []


def test_parse_samples_sci_notation() -> None:
    assert parse_samples(b"ch1:1e3\n") == [(1, 1000.0)]


def test_parse_samples_cjk_line() -> None:
    assert parse_samples(b"temp: 85.3 ch1:5.0\r\n") == [(1, 5.0)]


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


def test_waveform_channel_clear() -> None:
    ch = WaveformChannel("ch")
    ch.append(1.0)
    ch.append(2.0)
    ch.clear()
    assert ch.data()[1] == []


def test_waveform_channel_resize() -> None:
    ch = WaveformChannel("ch", max_points=100)
    for v in range(10):
        ch.append(float(v))
    ch.set_max_points(20)
    _, ys = ch.data()
    assert ys == [float(v) for v in range(10)]  # 未超新上限，全部保留
    ch.set_max_points(4)  # 下限钳制 16：已有 10 点未超，全部保留
    assert ch.data()[1] == [float(v) for v in range(10)]
    # 真正触发裁剪：上限设小且数据超上限
    for v in range(100, 120):
        ch.append(float(v))
    ys = ch.data()[1]
    assert len(ys) == 16
    assert ys[0] == 104.0  # 只保留最后 16 点


def test_waveform_channel_resize_min_clamp() -> None:
    ch = WaveformChannel("ch", max_points=100)
    ch.set_max_points(2)
    assert ch._max >= 16  # 下限钳制


# ---------- 页面 ----------


def _build_page(bus: EventBus | None = None) -> PlotPage:
    with dpg.window():
        with dpg.group(tag="page_plot"):
            return PlotPage("page_plot", bus or EventBus())


def test_plot_page_builds(dpg_ctx: None) -> None:
    _build_page()
    assert dpg.does_item_exist("plot_waveform")
    assert dpg.does_item_exist("plot_series_ch1")
    assert dpg.does_item_exist(f"plot_series_ch{CHANNEL_COUNT}")


def test_plot_page_consumes_stream(dpg_ctx: None) -> None:
    bus = EventBus()
    page = _build_page(bus)
    bus.publish_raw(b"ch1:1 ch2:2\n")
    page.render()
    assert page._channels[0].data()[1] == [1.0]
    assert page._channels[1].data()[1] == [2.0]


def test_plot_page_ignores_non_sample(dpg_ctx: None) -> None:
    bus = EventBus()
    page = _build_page(bus)
    bus.publish_raw(b"[I] system boot ok\r\n")
    page.render()
    assert page._channels[0].data()[1] == []


def test_plot_page_toggle_visibility(dpg_ctx: None) -> None:
    page = _build_page()
    page._on_visibility(0, False, 1)
    assert not dpg.get_item_configuration("plot_series_ch1")["show"]
    page._on_visibility(0, True, 1)
    assert dpg.get_item_configuration("plot_series_ch1")["show"]


def test_plot_page_clear(dpg_ctx: None) -> None:
    bus = EventBus()
    page = _build_page(bus)
    bus.publish_raw(b"ch1:1\n")
    page.render()
    assert page._channels[0].data()[1] == [1.0]
    page._on_clear()
    assert page._channels[0].data()[1] == []


def test_plot_page_max_points(dpg_ctx: None) -> None:
    bus = EventBus()
    page = _build_page(bus)
    page._on_max_points(20)
    bus.publish_raw(b"ch1:1\nch1:2\nch1:3\n")
    page.render()
    assert page._channels[0].data()[1] == [1.0, 2.0, 3.0]
    page._on_max_points(2)  # 下限钳制到 16，3 点全部保留
    assert page._channels[0].data()[1] == [1.0, 2.0, 3.0]
