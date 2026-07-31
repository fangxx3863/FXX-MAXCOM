"""日志引擎组装（LOG-T03）。

原始流 → 分行 → 染色 → 过滤 → LogEntry（时间戳来自分包帧或数据到达时刻）。
在独立后台线程运行（ADR-0015，INV-4）：从 EventBus 订阅原始流，循环消费，不阻塞 I/O。

关键：**分行不依赖分包**（LOG-T02，ADR-0014）。每个数据 chunk 到达立即拆行，
分包（TimestampManager）只提供时间戳基准——持续数据流下不封帧，行照常显示，
时间戳取数据到达时刻；静默后空闲超时封包，尾行用帧时间戳。
顺序：先染色后过滤（INV-1），被过滤行不显示但仍染色（用于文件，O2 待定）。
"""

from __future__ import annotations

import queue as _queue
import threading
import time
from collections.abc import Callable

from core.colorize.engine import ColorizeEngine
from core.filter.engine import FilterEngine
from core.logview.framing import TimedFrame, TimestampManager
from core.logview.splitter import LineSplitter, LogEntry
from core.pipeline.encoding import EncodingDetector
from core.pipeline.event_bus import EventBus

# LogEngine 心跳：独立定时器驱动 poll()（数据流空闲时也要封包）。
POLL_INTERVAL_MS = 50
POLL_EXIT_DELAY_S = 0.3


class LogEngine:
    """日志路径组装引擎。后台线程订阅 EventBus 消费原始流。"""

    def __init__(
        self,
        bus: EventBus,
        colorize: ColorizeEngine,
        filter_: FilterEngine,
        encoding: EncodingDetector,
        idle_timeout_ms: int = 100,
    ) -> None:
        self._bus = bus
        self._colorize = colorize
        self._filter = filter_
        self._encoding = encoding
        self._ts = TimestampManager(idle_timeout_ms)
        self._splitter = LineSplitter()
        self._running = False
        self._thread: threading.Thread | None = None
        self._on_entry: Callable[[LogEntry], None] | None = None

    def set_idle_timeout_ms(self, ms: int) -> None:
        self._ts.set_idle_timeout_ms(ms)

    def set_on_entry(self, callback: Callable[[LogEntry], None]) -> None:
        """注册 LogEntry 消费回调（渲染/落盘）。"""
        self._on_entry = callback

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="logview")
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=POLL_EXIT_DELAY_S + 0.5)
            self._thread = None
        # 停止时强制封包并刷残余行
        self._drain_pending()

    def on_frame(self, frame: TimedFrame) -> None:
        """处理一帧分包：立即拆行 → 染色 → 过滤 → 回调（供测试/直调路径）。"""
        self._process_chunk(frame.timestamp_ms, frame.data)

    def on_data(self, data: bytes) -> None:
        """直接处理数据 chunk（持续流路径）：更新空闲锚点，并立即拆行（不缓存字节）。"""
        ts_ms = self._now_ms()
        if self._ts.enabled:
            self._ts.touch()
        self._process_chunk(ts_ms, data)

    def _process_chunk(self, timestamp_ms: int, data: bytes) -> None:
        for raw_line in self._splitter.feed(data):
            self._process_line(timestamp_ms, raw_line)

    def _process_line(self, timestamp_ms: int, raw_line: bytes) -> None:
        text = self._encoding.decode(raw_line, "auto")
        segments = self._colorize.process_line(text)
        entry = LogEntry(timestamp_ms, text, raw_line, segments)
        if self._filter.should_show(text) and self._on_entry is not None:
            self._on_entry(entry)

    def _run(self) -> None:
        """后台线程：订阅原始流 + 空闲定时器 poll（双路径封包）。"""
        q = self._bus.subscribe("logview")
        deadline = POLL_INTERVAL_MS / 1000.0
        while self._running:
            try:
                data = q.get(timeout=deadline)
            except _queue.Empty:
                self._poll_idle()
                continue
            self._poll_idle()
            self.on_data(data)
        self._bus.unsubscribe("logview")

    def _poll_idle(self) -> None:
        """空闲超时封包路径：数据流静默时把已超时的当前帧封出。"""
        for frame in self._ts.poll():
            self.on_frame(frame)

    def _drain_pending(self) -> None:
        frame = self._ts.flush()
        if frame is not None:
            self.on_frame(frame)
        for raw_line in self._splitter.flush():
            self._process_line(0, raw_line)

    def _now_ms(self) -> int:
        return int(time.monotonic() * 1000)
