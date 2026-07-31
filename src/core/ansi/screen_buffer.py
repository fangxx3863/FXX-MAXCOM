"""屏幕缓冲区（ANS-T07）。

二维字符网格，每行固定宽度 list[Cell]。Cell = (char, SgrState)。
CJK 宽字符占 2 列：第二列放占位符 " "（渲染层按 is_wide 跳过或连字）。
行级脏标记：写操作只标记受影响行，GUI 只重绘 changed_lines。
宽字符不能跨行拆断：光标在行尾写宽字符时钳制（不写、不折行，INV-2 + 禁止折行）。
"""

from __future__ import annotations

from dataclasses import dataclass

from core.ansi.sgr import SgrState

BLANK = " "
WIDE = " "  # 占位标记：渲染时用于跳过/占宽


def is_wide_char(ch: str) -> bool:
    """终端列宽判定：全宽字符（CJK/框线/全角符号）占 2 列。

    与 tools/spike_terminal.py 的 display_width 保持同一宽度表（ADR-0017 后果）。
    """
    cp = ord(ch)
    if 0x2500 <= cp <= 0x27FF:  # 框线 + 终端符号
        return True
    if 0x2E80 <= cp <= 0x9FFF:  # CJK 统一表意 + 部首
        return True
    if 0x3000 <= cp <= 0x303F:  # CJK 标点
        return True
    if 0xFF00 <= cp <= 0xFFEF:  # 全角形式
        return True
    return 0x20000 <= cp <= 0x2FFFF  # CJK 扩展


@dataclass(frozen=True)
class Cell:
    """单个屏幕单元。char 为占位符时样式无意义。"""

    char: str
    style: SgrState

    @classmethod
    def blank(cls, style: SgrState | None = None) -> Cell:
        return cls(BLANK, style or SgrState())


class ScreenBuffer:
    """固定尺寸屏幕缓冲，带行级脏标记与 CJK 宽字符支持。"""

    def __init__(self, rows: int, cols: int) -> None:
        self._rows = rows
        self._cols = cols
        self._grid: list[list[Cell]] = [[Cell.blank() for _ in range(cols)] for _ in range(rows)]
        self._dirty: set[int] = set()
        # 光标位置（0-based），列位置恒为"当前列起点"
        self._cursor_row = 0
        self._cursor_col = 0
        self._save_cursor: tuple[int, int, SgrState] | None = None

    @property
    def cursor_row(self) -> int:
        return self._cursor_row

    @property
    def cursor_col(self) -> int:
        return self._cursor_col

    def row_count(self) -> int:
        return self._rows

    def col_count(self) -> int:
        return self._cols

    # ---------- 光标 ----------

    def move_cursor(self, row: int, col: int) -> None:
        """设置光标（0-based，钳制在屏内）。"""
        self._cursor_row = max(0, min(row, self._rows - 1))
        self._cursor_col = max(0, min(col, self._cols - 1))

    def move_cursor_col(self, col: int) -> None:
        self.move_cursor(self._cursor_row, col)

    def move_cursor_row(self, row: int) -> None:
        self.move_cursor(row, self._cursor_col)

    def cursor_left(self, n: int = 1) -> None:
        self.move_cursor(self._cursor_row, self._cursor_col - n)

    def cursor_right(self, n: int = 1) -> None:
        self.move_cursor(self._cursor_row, self._cursor_col + n)

    def save_cursor(self, style: SgrState | None = None) -> None:
        self._save_cursor = (self._cursor_row, self._cursor_col, style or SgrState())

    def restore_cursor(self) -> SgrState | None:
        """恢复光标位置，返回保存的样式（供解析器恢复 SGR）。无保存则不动。"""
        if self._save_cursor is None:
            return None
        row, col, style = self._save_cursor
        self.move_cursor(row, col)
        return style

    # ---------- 写入 ----------

    def write_char(self, ch: str, style: SgrState) -> None:
        """在光标处写入字符，光标右移（按宽字符占 2 列）。"""
        if self._cursor_col >= self._cols:
            return
        wide = is_wide_char(ch)
        if wide and self._cursor_col + 2 > self._cols:
            return  # 行尾宽字符：钳制不写、不折行
        self._set(self._cursor_row, self._cursor_col, Cell(ch, style))
        if wide:
            self._set(self._cursor_row, self._cursor_col + 1, Cell(WIDE, style))
            self._cursor_col += 2
        else:
            self._cursor_col += 1

    def set_cell(self, row: int, col: int, cell: Cell) -> None:
        self._set(row, col, cell)

    def get_cell(self, row: int, col: int) -> Cell:
        return self._grid[row][col]

    def get_row(self, row: int) -> list[Cell]:
        return self._grid[row]

    def _set(self, row: int, col: int, cell: Cell) -> None:
        if not (0 <= row < self._rows and 0 <= col < self._cols):
            return
        if self._grid[row][col] == cell:
            return
        self._grid[row][col] = cell
        self._dirty.add(row)

    # ---------- 行/区域操作 ----------

    def clear_cell(self, row: int, col: int, style: SgrState) -> None:
        self._set(row, col, Cell.blank(style))

    def fill_row(self, row: int, style: SgrState) -> None:
        for col in range(self._cols):
            self._set(row, col, Cell.blank(style))

    def fill_region(self, top: int, left: int, bottom: int, right: int, style: SgrState) -> None:
        """填充 [top..bottom) x [left..right) 半开区间为空白（标准 range 语义）。"""
        for row in range(max(0, top), min(bottom, self._rows)):
            for col in range(max(0, left), min(right, self._cols)):
                self._set(row, col, Cell.blank(style))

    # ---------- 滚动区域（ANS-T04） ----------

    def scroll_up(self, n: int, top: int, bottom: int) -> None:
        """滚动区域内行整体上移 n，底部 n 行用空行填充。滚出行由调用方入回滚。"""
        if top > bottom:
            return
        n = max(0, min(n, bottom - top + 1))
        if n == 0:
            return
        for row in range(top, bottom - n + 1):
            for col in range(self._cols):
                self._set(row, col, self._grid[row + n][col])
        for row in range(bottom - n + 1, bottom + 1):
            for col in range(self._cols):
                self._set(row, col, Cell.blank())
        self._dirty.update(range(top, bottom + 1))

    def scroll_down(self, n: int, top: int, bottom: int) -> None:
        """滚动区域内行整体下移 n，顶部 n 行填充空行。"""
        if top > bottom:
            return
        n = max(0, min(n, bottom - top + 1))
        if n == 0:
            return
        for row in range(bottom, top + n - 1, -1):
            for col in range(self._cols):
                self._set(row, col, self._grid[row - n][col])
        for row in range(top, top + n):
            for col in range(self._cols):
                self._set(row, col, Cell.blank())
        self._dirty.update(range(top, bottom + 1))

    # ---------- 脏标记 ----------

    def get_dirty_rows(self) -> set[int]:
        return set(self._dirty)

    def clear_dirty(self) -> None:
        self._dirty.clear()

    def mark_dirty(self, row: int) -> None:
        if 0 <= row < self._rows:
            self._dirty.add(row)

    # ---------- 读取 ----------

    def get_visible_rows(self) -> list[list[Cell]]:
        return [list(row) for row in self._grid]

    def get_row_text(self, row: int) -> str:
        return "".join(cell.char for cell in self._grid[row])


def blank_cell_row(cols: int) -> list[Cell]:
    return [Cell.blank() for _ in range(cols)]
