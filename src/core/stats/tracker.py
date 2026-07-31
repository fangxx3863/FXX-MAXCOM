"""统计追踪（P4 统计页数据源）。

订阅 EventBus 原始流统计累计 RX 字节 + 滑动窗口实时速率；TX 由发送路径
主动上报（record_tx）。错误帧统计当前为占位（M3 帧解析接入后由解析器上报）。
"""

from __future__ import annotations

import queue
import threading
import time
from collections import deque
from collections.abc import Callable

from core.pipeline.event_bus import EventBus

# 速率滑动窗口（秒）
RATE_WINDOW_S = 2.0


class StatsTracker:
    """累计字节 + 实时速率 + 错误帧计数。"""

    def __init__(self, bus: EventBus, now: Callable[[], float] | None = None) -> None:
        self._bus = bus
        self._q: queue.Queue[bytes] = bus.subscribe("stats")
        # 时间戳源：默认单调钟，测试可注入
        self._now = now if now is not None else time.monotonic
        self._rx_total = 0
        self._tx_total = 0
        self._rx_window: deque[tuple[float, int]] = deque()
        self._tx_window: deque[tuple[float, int]] = deque()
        self._crc_errors = 0
        self._frame_errors = 0
        self._lock = threading.Lock()
        self._last_sweep = 0.0

    def poll(self) -> None:
        """从订阅队列消费 RX 数据并更新统计（帧回调调用）。"""
        while True:
            try:
                data = self._q.get_nowait()
            except queue.Empty:
                break
            self.record_rx(len(data))

    def record_rx(self, n: int) -> None:
        now = self._now()
        with self._lock:
            self._rx_total += n
            self._rx_window.append((now, n))
            self._sweep(now)

    def record_tx(self, n: int) -> None:
        now = self._now()
        with self._lock:
            self._tx_total += n
            self._tx_window.append((now, n))
            self._sweep(now)

    def record_crc_error(self) -> None:
        with self._lock:
            self._crc_errors += 1

    def record_frame_error(self) -> None:
        with self._lock:
            self._frame_errors += 1

    def _sweep(self, now: float) -> None:
        # 丢出窗口外的采样
        cutoff = now - RATE_WINDOW_S
        while self._rx_window and self._rx_window[0][0] < cutoff:
            self._rx_window.popleft()
        while self._tx_window and self._tx_window[0][0] < cutoff:
            self._tx_window.popleft()
        self._last_sweep = now

    def rx_bytes(self) -> int:
        with self._lock:
            return self._rx_total

    def tx_bytes(self) -> int:
        with self._lock:
            return self._tx_total

    def rx_rate_kbs(self) -> float:
        """最近窗口 RX 速率（KB/s）。"""
        return self._rate(self._rx_window)

    def tx_rate_kbs(self) -> float:
        return self._rate(self._tx_window)

    def _rate(self, window: deque[tuple[float, int]]) -> float:
        now = self._now()
        with self._lock:
            total = sum(n for _, n in window)
            span = max(now - window[0][0], 1e-6) if window else 0.0
        if span <= 0:
            return 0.0
        return (total / span) / 1024.0

    def crc_errors(self) -> int:
        with self._lock:
            return self._crc_errors

    def frame_errors(self) -> int:
        with self._lock:
            return self._frame_errors
