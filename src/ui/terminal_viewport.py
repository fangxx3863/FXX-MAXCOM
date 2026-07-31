"""终端 Viewport 渲染（TERM-T01/T06/T07）。

DPG draw_text 逐行渲染 ScreenBuffer：只画 dirty_rows 交集可见区，画完 clear_dirty。
多色行按连续同色段合并 draw_text 调用（ADR-0017：逐行而非逐 cell）。
CJK 宽字符按 2 倍字宽定位、占位列跳过。
回滚上滚：渲染"回滚区 + 当前屏"拼接，不改 ScreenBuffer（INV-3）。
光标层独立每帧重画（闪烁相位 + CSI ?25 显隐）。
"""

from __future__ import annotations

import dearpygui.dearpygui as dpg

from core.ansi.screen_buffer import Cell, ScreenBuffer, is_wide_char
from core.ansi.scrollback import ScrollbackBuffer
from core.ansi.sgr import SgrState
from core.terminal.selection import TextSelection

# ANSI 16 色调色板（与 sgr.BASIC_COLORS 一致，供渲染取色）
PALETTE: tuple[tuple[int, int, int], ...] = (
    (0x00, 0x00, 0x00),
    (0xCC, 0x00, 0x00),
    (0x00, 0xCC, 0x00),
    (0xCC, 0xCC, 0x00),
    (0x00, 0x00, 0xCC),
    (0xCC, 0x00, 0xCC),
    (0x00, 0xCC, 0xCC),
    (0xCC, 0xCC, 0xCC),
    (0x66, 0x66, 0x66),
    (0xFF, 0x33, 0x33),
    (0x33, 0xFF, 0x33),
    (0xFF, 0xFF, 0x33),
    (0x33, 0x33, 0xFF),
    (0xFF, 0x33, 0xFF),
    (0x33, 0xFF, 0xFF),
    (0xFF, 0xFF, 0xFF),
)

DEFAULT_FG = (220, 220, 224)
DEFAULT_BG = (16, 16, 20)
CURSOR_COLOR = (0, 122, 255)
SELECTION_BG = (40, 90, 160)


def _cube_component(v: int) -> int:
    return 0 if v == 0 else 55 + v * 40


def _xterm(idx: int) -> tuple[int, int, int]:
    if idx < 16:
        return PALETTE[idx]
    if idx < 232:
        n = idx - 16
        r, g, b = n // 36, (n // 6) % 6, n % 6
        return (_cube_component(r), _cube_component(g), _cube_component(b))
    v = 8 + (idx - 232) * 10
    return (v, v, v)


def _fg(style: SgrState) -> tuple[int, int, int]:
    color = style.bg if style.reverse else style.fg
    if isinstance(color, tuple):
        return color
    if isinstance(color, int):
        return _xterm(color)
    return DEFAULT_FG


def _bg(style: SgrState) -> tuple[int, int, int]:
    color = style.fg if style.reverse else style.bg
    if isinstance(color, tuple):
        return color
    if isinstance(color, int):
        return _xterm(color)
    return DEFAULT_BG


class TerminalViewport:
    """交互式终端渲染 viewport。headless 下渲染方法需 DPG context。"""

    def __init__(
        self,
        parent: int | str,
        buffer: ScreenBuffer,
        scrollback: ScrollbackBuffer | None = None,
        font_size: int = 16,
        cols: int = 80,
        rows: int = 24,
    ) -> None:
        self._parent = parent
        self._buffer = buffer
        self._scrollback = scrollback or ScrollbackBuffer(10000)
        self._font_size = font_size
        self._line_h = font_size + 2
        self._cell_w = font_size * 0.62  # 等宽字宽近似（Consolas）
        self._cols = cols
        self._rows = rows
        self._scroll_offset = 0  # 上滚行数（0 = 跟随新输出）
        self._selection = TextSelection(self._get_row)
        self._cursor_visible = True
        self._draw = 0

    def cell_size(self) -> tuple[float, float]:
        return (self._cell_w, self._line_h)

    @property
    def scroll_offset(self) -> int:
        return self._scroll_offset

    # ---------- 回滚查看 ----------

    def scroll_view(self, rows: int) -> None:
        """调整上滚偏移（非终端自身滚动）。"""
        max_offset = self._scrollback.line_count
        self._scroll_offset = max(0, min(self._scroll_offset + rows, max_offset))

    def scroll_to_bottom(self) -> None:
        self._scroll_offset = 0

    def follow_output(self) -> bool:
        return self._scroll_offset == 0

    # ---------- 渲染 ----------

    def render(self) -> None:
        """画可见区全部行。headless 下需要 DPG context + drawlist 父节点。"""
        self._ensure_drawlist()
        dpg.delete_item(self._draw, children_only=True)
        visible = self._visible_lines()
        for i, cells in enumerate(visible):
            self._render_line(i, cells)
        self._buffer.clear_dirty()

    def render_cursor(self, blink_on: bool) -> None:
        if not self._cursor_visible or not blink_on or self._scroll_offset > 0:
            return
        self._ensure_drawlist()
        row, col = self._buffer.cursor_row, self._buffer.cursor_col
        x = col * self._cell_w
        y = row * self._line_h
        dpg.draw_rectangle(
            (x, y),
            (x + self._cell_w, y + self._line_h),
            fill=CURSOR_COLOR,
            parent=self._draw,
        )

    def set_cursor_visible(self, visible: bool) -> None:
        self._cursor_visible = visible

    # ---------- 内部 ----------

    def _ensure_drawlist(self) -> None:
        if dpg.does_item_exist(self._draw):
            return
        self._draw = dpg.add_drawlist(width=1280, height=800, parent=self._parent)

    def _visible_lines(self) -> list[list[Cell]]:
        """回滚区 + 当前屏拼接（回滚在上）。"""
        out: list[list[Cell]] = []
        if self._scroll_offset > 0:
            back_rows = self._scrollback.read_back_rows(
                self._scroll_offset - 1, self._scroll_offset
            )
            if back_rows:
                out.extend(back_rows)
        for r in range(self._rows):
            out.append(self._buffer.get_row(r))
        return out

    def _render_line(self, screen_row: int, cells: list[Cell]) -> None:
        y = screen_row * self._line_h
        highlight = self._selection.render_highlight()
        col = 0
        while col < len(cells):
            cell = cells[col]
            if cell.char == " " or cell.char == "":
                col += 1
                continue
            fg = _fg(cell.style)
            bg = _bg(cell.style)
            is_sel = (screen_row, col) in highlight
            seg_start = col
            text_parts: list[str] = []
            width = 0
            while col < len(cells):
                c = cells[col]
                if c.char == " " or c.char == "":
                    break
                if _fg(c.style) != fg or _bg(c.style) != bg:
                    break
                if ((screen_row, col) in highlight) != is_sel:
                    break
                if is_wide_char(c.char):
                    if text_parts:
                        break
                    text_parts.append(c.char)
                    width += 2
                    col += 2
                    continue
                text_parts.append(c.char)
                width += 1
                col += 1
            x = seg_start * self._cell_w
            text = "".join(text_parts)
            if is_sel:
                dpg.draw_rectangle(
                    (x, y),
                    (x + width * self._cell_w, y + self._line_h),
                    fill=SELECTION_BG,
                    parent=self._draw,
                )
            dpg.draw_text((x, y), text, color=fg, parent=self._draw, size=self._font_size)

    def _get_row(self, row: int) -> list[Cell]:
        return self._buffer.get_row(row)
