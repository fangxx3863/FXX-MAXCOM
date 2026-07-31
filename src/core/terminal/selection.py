"""文本选择 → 复制（TERM-T04）。

拖选屏幕/回滚区文本，提取跨行文本供剪贴板。只复制不发送（INV-2）。
CJK 宽字符：占位列不参与文本提取（不截半字符）。
"""

from __future__ import annotations

from collections.abc import Callable

from core.ansi.screen_buffer import Cell, is_wide_char


class TextSelection:
    """基于 cell 坐标（行,列）的拖选。数据源由 get_row 回调提供。"""

    def __init__(self, get_row: Callable[[int], list[Cell]]) -> None:
        self._get_row = get_row
        self._anchor: tuple[int, int] | None = None
        self._current: tuple[int, int] | None = None

    @property
    def active(self) -> bool:
        return self._anchor is not None and self._current is not None

    def begin(self, cell: tuple[int, int]) -> None:
        self._anchor = cell
        self._current = cell

    def extend(self, cell: tuple[int, int]) -> None:
        if self._anchor is None:
            self.begin(cell)
            return
        self._current = cell

    def clear(self) -> None:
        self._anchor = None
        self._current = None

    def bounds(self) -> tuple[int, int, int, int] | None:
        """返回归一化矩形 (min_row, min_col, max_row, max_col)，无选中返回 None。"""
        if self._anchor is None or self._current is None:
            return None
        ar, ac = self._anchor
        cr, cc = self._current
        return (min(ar, cr), min(ac, cc), max(ar, cr), max(ac, cc))

    def render_highlight(self) -> set[tuple[int, int]]:
        """选中 cell 集合，供渲染叠加高亮。"""
        b = self.bounds()
        if b is None:
            return set()
        top, left, bottom, right = b
        return {(r, c) for r in range(top, bottom + 1) for c in range(left, right + 1)}

    def copy_to_clipboard(self) -> str:
        """提取选中区文本（跨行 + \\n）。返回空串表示无选中。"""
        b = self.bounds()
        if b is None:
            return ""
        top, left, bottom, right = b
        lines: list[str] = []
        for row in range(top, bottom + 1):
            cells = self._get_row(row)
            parts: list[str] = []
            for col in range(left, right + 1):
                if col >= len(cells):
                    break
                ch = cells[col].char
                if ch == "":
                    continue
                # 跳过宽字符的占位列（前一个 cell 是宽字符）
                if col > 0 and is_wide_char(cells[col - 1].char):
                    continue
                parts.append(ch)
            lines.append("".join(parts))
        return "\n".join(lines)
