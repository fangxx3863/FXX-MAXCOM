"""分行 + LogEntry（LOG-T02）。

按 CRLF / LF / CR 拆行（ADR-0014），跨片段拼行：splitter 持有未完成行（有状态）。
CRLF 视为单个换行符；单独 CR、LF 也是换行。空行保留。flush 返回未尾随换行的残余行。
"""

from __future__ import annotations

from dataclasses import dataclass

from core.colorize.engine import ColoredSegment


@dataclass
class LogEntry:
    """一行日志：时间戳 + 文本 + 原始字节 + 颜色段（染色后填充）。"""

    timestamp_ms: int
    text: str
    raw: bytes
    segments: list[ColoredSegment] | None = None


class LineSplitter:
    """字节流 → 行（bytes）。有状态：跨片段保留未完成行。"""

    def __init__(self) -> None:
        self._pending = bytearray()

    @property
    def pending_bytes(self) -> int:
        return len(self._pending)

    def feed(self, data: bytes) -> list[bytes]:
        """追加数据，按换行拆行。行尾 \r 视为终结（\r 后跟 \n 合并）。"""
        self._pending += data
        lines: list[bytes] = []
        buf = self._pending
        start = 0
        i = 0
        while i < len(buf):
            c = buf[i]
            if c == 0x0A:  # \n：终结符
                lines.append(bytes(buf[start:i]))
                i += 1
                start = i
            elif c == 0x0D:  # \r：终结符（其后跟 \n 时吞掉，避免空行）
                lines.append(bytes(buf[start:i]))
                i += 1
                if i < len(buf) and buf[i] == 0x0A:
                    i += 1
                start = i
            else:
                i += 1
        # 保留未完成行
        if start > 0:
            del self._pending[:start]
        return lines

    def flush(self) -> list[bytes]:
        """返回未尾随换行的残余行，并清空缓冲。"""
        if not self._pending:
            return []
        rest = bytes(self._pending)
        self._pending.clear()
        return [rest]
