"""粘贴管理（TERM-T05）。

多行文本逐行发送 + 行间延迟（默认 10ms，ADR-0009）。后台线程发送，不阻塞 GUI。
粘贴期间击键直传应暂停（由调用方协调）；Esc 中止。
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable

DEFAULT_DELAY_MS = 10


class _Sentinel:
    pass


_SENTINEL = _Sentinel()


class PasteManager:
    """逐行入队发送；后台线程按行间延迟消费。"""

    def __init__(self, send: Callable[[bytes], None]) -> None:
        self._send = send
        self._q: queue.Queue[bytes | _Sentinel] = queue.Queue()
        self._delay_ms = DEFAULT_DELAY_MS
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def set_delay_ms(self, ms: int) -> None:
        self._delay_ms = max(0, ms)

    def paste(self, text: str, end: str = "\r\n") -> None:
        """按行拆分，逐行入队发送。空行保留；行尾换行形式由 end 决定。"""
        lines = text.split("\n")
        for i, line in enumerate(lines):
            if i < len(lines) - 1:
                payload = (line + end).encode("utf-8", errors="replace")
            else:
                payload = line.encode("utf-8", errors="replace")
            self._q.put(payload)

    def abort(self) -> None:
        """中止：清空待发队列（已入队但未发送的行丢弃）。"""
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break

    @property
    def is_active(self) -> bool:
        return not self._q.empty()

    def close(self) -> None:
        self._q.put(_SENTINEL)

    def _run(self) -> None:
        while True:
            item = self._q.get()
            if isinstance(item, _Sentinel):
                break
            self._send(item)
            if self._delay_ms > 0 and not self._q.empty():
                time.sleep(self._delay_ms / 1000.0)
