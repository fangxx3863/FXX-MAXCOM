"""传统收发模块测试（LOG-T01..T03 DoD 全覆盖）。

framing/splitter 纯逻辑 headless 可测；engine 组装链路用 on_frame 直调，
后台线程测试用真实 EventBus 驱动。
"""

from __future__ import annotations

import queue
import time

from app.models.filter_rule import FilterRule
from core.colorize.engine import ColorizeEngine
from core.filter.engine import FilterEngine
from core.logview.engine import LogEngine
from core.logview.framing import TimedFrame, TimestampManager, format_timestamp
from core.logview.splitter import LineSplitter, LogEntry
from core.pipeline.encoding import EncodingDetector


class _Empty(Exception):
    pass


class _EmptyQueue:
    """永远超时的队列（模拟空总线队列）。"""

    def get(self, timeout: float = 0.0) -> bytes:
        raise _Empty()


class _FakeBus:
    def __init__(self, q: queue.Queue[bytes] | None = None) -> None:
        self._q: queue.Queue[bytes] | None = q
        self.stopped = False

    def subscribe(self, name: str) -> queue.Queue[bytes] | _EmptyQueue:
        if self._q is not None:
            return self._q
        return _EmptyQueue()

    def unsubscribe(self, name: str) -> None:
        self.stopped = True


# ---------- LOG-T01: 智能分包 + 时间戳 ----------


class _FakeClock:
    """可控 monotonic 时钟：test 内手动前移，避免真实 sleep。"""

    def __init__(self, start_ms: int = 0) -> None:
        self.now_ms = start_ms

    def now(self) -> int:
        return self.now_ms


def _make_ts(clock: _FakeClock, timeout_ms: int = 100) -> TimestampManager:
    ts = TimestampManager(timeout_ms)
    ts._now_ms = clock.now  # 替换单调时钟为可控时钟
    return ts


def test_ts_frame_sealed_after_idle() -> None:
    clock = _FakeClock(1000)
    ts = _make_ts(clock)
    assert ts.feed(b"ab") == []  # 未超时，留在当前帧
    clock.now_ms = 1150  # 空闲 150ms
    frames = ts.poll()  # 空闲超时判定路径
    assert frames == [TimedFrame(1000, b"ab")]


def test_ts_mid_stream_idle_split() -> None:
    clock = _FakeClock(5000)
    ts = _make_ts(clock)
    ts.feed(b"a")
    clock.now_ms = 5150  # 150ms > 100ms 空闲
    frames = ts.feed(b"b")
    # 前帧 a 已超时 → 封出；b 进入新帧
    assert frames == [TimedFrame(5000, b"a")]
    assert ts.pending_bytes == 1


def test_ts_flush_force_seal() -> None:
    clock = _FakeClock(2000)
    ts = _make_ts(clock)
    ts.feed(b"hello")
    frame = ts.flush()
    assert frame == TimedFrame(2000, b"hello")
    assert ts.flush() is None  # 空缓冲


def test_ts_disabled_passthrough() -> None:
    clock = _FakeClock(0)
    ts = TimestampManager(100, enabled=False)
    ts._now_ms = clock.now
    assert ts.feed(b"x") == []
    assert ts.poll() == []
    assert ts.flush() is None


def test_ts_idle_timeout_config() -> None:
    clock = _FakeClock(0)
    ts = _make_ts(clock)
    ts.set_idle_timeout_ms(10)
    assert ts.idle_timeout_ms == 10
    ts.set_idle_timeout_ms(0)  # 非法值钳制为 1
    assert ts.idle_timeout_ms == 1


def test_format_timestamp_absolute() -> None:
    assert format_timestamp(0, "absolute", epoch_ms=3600_000 + 5_000 + 123) == "01:00:05.123"
    assert format_timestamp(456, "absolute", epoch_ms=0) == "00:00:00.456"


def test_format_timestamp_relative() -> None:
    assert format_timestamp(1500, "relative", base_ms=1000) == "+500ms"
    assert format_timestamp(1000, "relative", base_ms=1000) == "+0ms"


def test_format_timestamp_delta() -> None:
    assert format_timestamp(1200, "delta", base_ms=1000) == "Δ+200ms"
    assert format_timestamp(900, "delta", base_ms=1000) == "Δ-100ms"
    assert format_timestamp(1000, "delta", base_ms=None) == "+0ms"


# ---------- LOG-T02: 分行 + LogEntry ----------


def test_split_crlf() -> None:
    s = LineSplitter()
    assert s.feed(b"a\r\nb\r\n") == [b"a", b"b"]


def test_split_lf() -> None:
    s = LineSplitter()
    assert s.feed(b"a\nb\n") == [b"a", b"b"]


def test_split_lone_cr() -> None:
    s = LineSplitter()
    assert s.feed(b"a\rb\r") == [b"a", b"b"]


def test_split_mixed() -> None:
    s = LineSplitter()
    assert s.feed(b"a\r\nb\nc\rd") == [b"a", b"b", b"c"]  # d 待续


def test_split_across_fragments() -> None:
    s = LineSplitter()
    assert s.feed(b"ab") == []  # 无换行，待续
    assert s.feed(b"cd\r\n") == [b"abcd"]
    assert s.feed(b"ef") == []
    assert s.feed(b"\n") == [b"ef"]


def test_split_empty_lines_kept() -> None:
    s = LineSplitter()
    assert s.feed(b"\n\n") == [b"", b""]
    assert s.feed(b"a\n\nb\n") == [b"a", b"", b"b"]


def test_split_crlf_not_double_line() -> None:
    s = LineSplitter()
    assert s.feed(b"a\r\nb") == [b"a"]  # \r\n 单换行，b 待续


def test_flush_returns_tail() -> None:
    s = LineSplitter()
    s.feed(b"a\nb")
    assert s.flush() == [b"b"]  # 无尾随换行的残余
    assert s.flush() == []  # 已清空


def test_splitter_pending_prop() -> None:
    s = LineSplitter()
    s.feed(b"ab")
    assert s.pending_bytes == 2


# ---------- LOG-T03: 日志引擎组装 ----------


def test_engine_full_chain() -> None:
    eng = LogEngine(_FakeBus(), ColorizeEngine(), FilterEngine(), EncodingDetector())
    entries: list[LogEntry] = []
    eng.set_on_entry(entries.append)
    eng.on_frame(TimedFrame(1000, b"[W] voltage: 3.3\n"))
    assert len(entries) == 1
    e = entries[0]
    assert e.timestamp_ms == 1000
    assert e.text == "[W] voltage: 3.3"
    assert e.raw == b"[W] voltage: 3.3"
    assert e.segments is not None
    assert e.segments[0].fg == "yellow"  # 等级括号染色


def test_engine_color_before_filter() -> None:
    colorize = ColorizeEngine()
    filter_ = FilterEngine()
    filter_.add_rule(FilterRule(name="hide_w", pattern=r"\[W\]", action="hide"))
    eng = LogEngine(_FakeBus(), colorize, filter_, EncodingDetector())
    entries: list[LogEntry] = []
    eng.set_on_entry(entries.append)
    eng.on_frame(TimedFrame(0, b"[W] hidden\n[E] shown\n"))
    # [W] 被过滤不显示；[E] 显示
    assert len(entries) == 1
    assert entries[0].text == "[E] shown"
    # 被过滤行仍染色（先染色后过滤 INV-1）
    segs = colorize.process_line("[W] hidden")
    assert segs[0].fg == "yellow"


def test_engine_encoding_and_split() -> None:
    eng = LogEngine(_FakeBus(), ColorizeEngine(), FilterEngine(), EncodingDetector())
    entries: list[LogEntry] = []
    eng.set_on_entry(entries.append)
    # 跨帧拼行：第一帧半行，第二帧补完 + 换行
    eng.on_frame(TimedFrame(100, b"line"))
    eng.on_frame(TimedFrame(200, b"-2 done\n"))
    assert len(entries) == 1
    assert entries[0].text == "line-2 done"
    assert entries[0].timestamp_ms == 200


def test_engine_background_thread() -> None:
    q: queue.Queue[bytes] = queue.Queue()
    eng = LogEngine(_FakeBus(q), ColorizeEngine(), FilterEngine(), EncodingDetector())
    entries: list[LogEntry] = []
    eng.set_on_entry(entries.append)
    eng.start()
    q.put(b"[I] started\n")
    time.sleep(0.1)
    eng.stop()
    assert any(e.text == "[I] started" for e in entries)
    assert not eng._running


def test_engine_drain_on_stop() -> None:
    eng = LogEngine(_FakeBus(), ColorizeEngine(), FilterEngine(), EncodingDetector())
    entries: list[LogEntry] = []
    eng.set_on_entry(entries.append)
    # 无换行残余：stop 时 flush 出
    eng.on_frame(TimedFrame(100, b"tail-no-newline"))
    assert entries == []  # 尚未出行
    eng._drain_pending()
    assert [e.text for e in entries] == ["tail-no-newline"]


def test_engine_splits_without_waiting_for_frame() -> None:
    """LOG-T02 不变量：分行不依赖分包。持续数据流下 chunk 到达即拆行显示。"""
    eng = LogEngine(_FakeBus(), ColorizeEngine(), FilterEngine(), EncodingDetector())
    entries: list[LogEntry] = []
    eng.set_on_entry(entries.append)
    # 模拟持续流：多个 chunk 未空闲，但每行含换行 → 立即出行
    eng.on_data(b"[I] line one\n")
    eng.on_data(b"[I] line two\n")
    eng.on_data(b"[I] line three\n")
    assert [e.text for e in entries] == ["[I] line one", "[I] line two", "[I] line three"]
    assert eng._ts.pending_bytes == 0  # 数据即时拆行，未留待封包


def test_engine_cross_chunk_line_within_frame() -> None:
    """跨 chunk 的半行在下一个 chunk 到达时拼行（不需等封包）。"""
    eng = LogEngine(_FakeBus(), ColorizeEngine(), FilterEngine(), EncodingDetector())
    entries: list[LogEntry] = []
    eng.set_on_entry(entries.append)
    eng.on_data(b"[I] part")
    assert entries == []  # 半行待续
    eng.on_data(b"-2\n")
    assert [e.text for e in entries] == ["[I] part-2"]
