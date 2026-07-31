"""回滚区搜索（TERM-T08）。

在回滚缓冲中搜索文本，返回命中位置（行偏移 + 列），供渲染高亮 + 跳转。
只读回滚区，不改数据。
CJK 宽字符：占位列（空格）不参与匹配，命中列映射回宽字符起始列（不截半）。
"""

from __future__ import annotations

from collections.abc import Callable, Iterator

from core.ansi.screen_buffer import Cell, is_wide_char


class ScrollbackSearch:
    """在行序列中搜索。行由 get_line 回调提供（回滚区或当前屏行）。"""

    def __init__(self, line_count: int, get_line: Callable[[int], list[Cell]]) -> None:
        self._line_count = line_count
        self._get_line = get_line

    def search(self, query: str) -> Iterator[tuple[int, int]]:
        """返回命中位置（行索引, 列）。query 为空不匹配。"""
        q = query.strip()
        if not q:
            return
        for idx in range(self._line_count):
            cells = self._get_line(idx)
            # 逻辑文本：跳过宽字符占位列（宽字符后紧跟的空格），记录真实列映射
            logical: list[str] = []
            col_map: list[int] = []
            for col, cell in enumerate(cells):
                ch = cell.char
                if col > 0 and ch == " " and is_wide_char(cells[col - 1].char):
                    continue  # 宽字符占位列，跳过
                logical.append(ch)
                col_map.append(col)
            text = "".join(logical)
            start = 0
            while True:
                pos = text.find(q, start)
                if pos < 0:
                    break
                yield (idx, col_map[pos])
                start = pos + len(q)


def search_in_cells(lines: list[list[Cell]], query: str) -> Iterator[tuple[int, int]]:
    """便捷入口：直接对行集合搜索（回滚区或当前屏）。"""
    s = ScrollbackSearch(len(lines), lambda i: lines[i])
    yield from s.search(query)
