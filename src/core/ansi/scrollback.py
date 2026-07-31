"""回滚缓冲区（ANS-T08）。

被滚出屏幕的行进入环形队列，容量可配（默认 10000 行）。
上滚查看时 GUI 拼接"回滚区 + 当前屏"渲染，不修改 ScreenBuffer 状态（回滚只读）。
超容丢弃最旧行。
"""

from __future__ import annotations

from collections import deque

from core.ansi.screen_buffer import Cell

DEFAULT_MAX_LINES = 10000


class ScrollbackBuffer:
    """环形回滚队列：push 行入队，read_back 向上读。"""

    def __init__(self, max_lines: int = DEFAULT_MAX_LINES) -> None:
        self._max = max(1, max_lines)
        self._lines: deque[list[Cell]] = deque(maxlen=self._max)

    def push(self, rows: list[list[Cell]]) -> None:
        """将滚出的行入队（整屏行或单行均可）。"""
        for row in rows:
            self._lines.append(row)

    def push_line(self, cells: list[Cell]) -> None:
        self._lines.append(cells)

    def read_back(self, offset: int) -> list[list[Cell]] | None:
        """offset>=0 表示上滚 offset 行；返回该位置行，超出返回 None。"""
        if offset < 0 or offset >= len(self._lines):
            return None
        idx = len(self._lines) - 1 - offset
        return [list(self._lines[idx])]

    def read_back_rows(self, offset: int, count: int) -> list[list[Cell]] | None:
        """从 offset 行向上读 count 行（offset 是距当前屏最近一行的偏移）。"""
        if offset < 0 or offset >= len(self._lines):
            return None
        end = len(self._lines) - offset
        start = max(0, end - count)
        return [list(r) for r in list(self._lines)[start:end]]

    @property
    def line_count(self) -> int:
        return len(self._lines)

    def clear(self) -> None:
        self._lines.clear()
