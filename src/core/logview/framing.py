"""智能分包 + 时间戳（LOG-T01）。

按空闲超时切分数据帧，每帧一个时间戳。空闲计时用 time.monotonic()（不受系统时间调整影响）。
独立开关（enabled=False）→ 透传不封包（ADR-0008）。
时间戳三种格式：绝对 HH:MM:SS.ms / 相对 +ms / 差值 Δms。
分包是日志路径本地行为，不改原始流（ADR-0015）。
"""

from __future__ import annotations

import time
from dataclasses import dataclass


@dataclass
class TimedFrame:
    """一帧数据 + 帧开始时间戳（毫秒，monotonic 基准）。"""

    timestamp_ms: int
    data: bytes


class TimestampManager:
    """空闲超时封包器。feed 追加到当前帧；空闲超时/中途空闲切分新帧。"""

    def __init__(self, idle_timeout_ms: int = 100, enabled: bool = True) -> None:
        self._timeout_ms = max(1, idle_timeout_ms)
        self.enabled = enabled
        self._buf = bytearray()
        self._frame_start_ms = 0
        self._last_activity_ms = 0

    def set_idle_timeout_ms(self, ms: int) -> None:
        self._timeout_ms = max(1, ms)

    @property
    def idle_timeout_ms(self) -> int:
        return self._timeout_ms

    @property
    def pending_bytes(self) -> int:
        return len(self._buf)

    def feed(self, data: bytes) -> list[TimedFrame]:
        """追加数据，返回已封好的帧（新到数据通常留在当前帧待空闲）。"""
        if not self.enabled:
            return []  # 开关关闭：不封包、不加时间戳，由调用方决定透传方式
        now_ms = self._now_ms()
        frames: list[TimedFrame] = []
        # 距上次活动已超时且当前帧非空 → 先把旧帧封掉，再开新帧
        if self._buf and now_ms - self._last_activity_ms >= self._timeout_ms:
            frames.append(self._seal())
        if not self._buf:
            self._frame_start_ms = now_ms
        self._buf += data
        self._last_activity_ms = now_ms
        return frames

    def poll(self, now_ms: int | None = None) -> list[TimedFrame]:
        """空闲超时判定路径（数据流空闲时由定时器调用）。"""
        if not self.enabled or not self._buf:
            return []
        now = self._now_ms() if now_ms is None else now_ms
        if now - self._last_activity_ms >= self._timeout_ms:
            return [self._seal()]
        return []

    def flush(self) -> TimedFrame | None:
        """强制封当前帧（连接关闭/清空时）。返回封出的帧；无缓冲返回 None。"""
        if not self.enabled or not self._buf:
            return None
        return self._seal()

    def _seal(self) -> TimedFrame:
        frame = TimedFrame(self._frame_start_ms, bytes(self._buf))
        self._buf.clear()
        return frame

    def _now_ms(self) -> int:
        return int(time.monotonic() * 1000)


def format_timestamp(
    timestamp_ms: int,
    mode: str,
    epoch_ms: int | None = None,
    base_ms: int | None = None,
) -> str:
    """按模式格式化时间戳：absolute / relative / delta。

    epoch_ms 为绝对时间基准（如程序启动时的 time.time()）；缺失用 0。
    base_ms 为差值基准（前一帧时间戳）；relative 用 base 或 epoch 计算偏移。
    """
    if mode == "delta":
        if base_ms is None:
            return "+0ms"
        return f"Δ{(timestamp_ms - base_ms):+d}ms"
    if mode == "relative":
        base = base_ms if base_ms is not None else (epoch_ms or 0)
        return f"+{timestamp_ms - base}ms"
    # absolute: HH:MM:SS.ms（epoch_ms + monotonic 偏移 = 墙钟时间，毫秒）
    total_ms = (epoch_ms or 0) + timestamp_ms
    ms = total_ms % 1000
    total_s = total_ms // 1000
    h = (total_s // 3600) % 24
    m = (total_s // 60) % 60
    s = total_s % 60
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"
