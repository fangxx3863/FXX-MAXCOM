"""传统收发模块（logview / LOG）。

日志引擎：智能分包 + 时间戳 → 分行 → 染色 → 过滤 → LogEntry。
后台线程运行，不改原始流（ADR-0015）。
"""

from core.logview.engine import LogEngine
from core.logview.framing import TimedFrame, TimestampManager, format_timestamp
from core.logview.splitter import LineSplitter, LogEntry

__all__ = [
    "LineSplitter",
    "LogEngine",
    "LogEntry",
    "TimedFrame",
    "TimestampManager",
    "format_timestamp",
]
