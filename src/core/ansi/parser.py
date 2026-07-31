"""ANSI 转义序列解析器（ANS 核心）。

逐字符状态机（GROUND/ESC/CSI/OSC/SKIP），输入 → 更新 ScreenBuffer。
纯函数式：无 GUI 依赖、无副作用（INV-4）。不支持的序列静默跳过 + 记录日志（INV-1）。

输入：
  - feed(bytes)：按 UTF-8 增量解码（跨分包边界安全，分包尾部不完整字节自动缓存）。
  - feed(str)：已解码文本直接处理（pipeline 用 EncodingDetector 解码后走此路径）。

实现序列：
  - SGR（CSI n m）
  - 光标：CUU/CUD/CUF/CUB/CHA/CUP/HVP/SCP/RCP（CSI s/u）
  - 擦除：ED（CSI n J）/ EL（CSI n K）
  - 滚动区域：DECSTBM（CSI r）
  - 插入/删除：IL/DL/DCH/ECH/ICH
  - DEC：DECSC（ESC 7）/DECRC（ESC 8）/RI（ESC M）/IND（ESC D）/NEL（ESC E）/RIS（ESC c）

限制：参数长度上限 MAX_PARAM_LEN（防 DoS）；private 前缀（? > 等）走 SKIP 到终结符。
"""

from __future__ import annotations

import codecs

from core.ansi import screen_buffer as sb
from core.ansi.screen_buffer import ScreenBuffer
from core.ansi.scrollback import ScrollbackBuffer
from core.ansi.sgr import SgrState, apply_sgr

GROUND, ESC, CSI_ENTRY, CSI_PARAM, OSC_STR, SKIP = range(6)
DEFAULT_ROWS, DEFAULT_COLS = 24, 80
MAX_PARAM_LEN = 4096  # 防 DoS：超长序列丢弃（ANS-T09）

# CSI 终结符 → 处理器分派
_CSI_DISPATCH: dict[str, str] = {
    "A": "cursor_up",
    "B": "cursor_down",
    "C": "cursor_forward",
    "D": "cursor_back",
    "G": "set_cursor_col",
    "H": "set_cursor",
    "f": "set_cursor",
    "J": "erase_in_display",
    "K": "erase_in_line",
    "m": "sgr",
    "r": "set_scroll_region",
    "L": "insert_lines",
    "M": "delete_lines",
    "P": "delete_char",
    "X": "erase_char",
    "@": "insert_char",
    "s": "save_cursor_pos",
    "u": "restore_cursor_pos",
}


class AnsiParser:
    """有状态解析器：feed 跨片段保留状态（分包边界安全，ANS-T09）。"""

    def __init__(
        self,
        rows: int = DEFAULT_ROWS,
        cols: int = DEFAULT_COLS,
        scrollback_max: int = 10000,
    ) -> None:
        self.buffer = ScreenBuffer(rows, cols)
        self.scrollback = ScrollbackBuffer(scrollback_max)
        self._state = GROUND
        self._params: list[int] = []
        self._raw = bytearray()  # 当前序列原始字节（供日志）
        self._skip_final: bool = False  # SKIP 态：终结符是任意 CSI final byte
        self._utf8_dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._style = SgrState()
        self._scroll_top = 0
        self._scroll_bottom = rows - 1
        self._unknown_seqs: list[str] = []

    # ---------- 公共 ----------

    def feed(self, data: bytes | str) -> None:
        if isinstance(data, bytes):
            for ch in self._utf8_dec.decode(data, final=False):
                self._feed_char(ch)
        else:
            for ch in data:
                self._feed_char(ch)

    def unknown_seq(self, seq: bytes) -> None:
        """记录未知/不支持序列，静默跳过（INV-1）。不抛异常。"""
        # 仅保留最近若干条，防内存无限增长
        text = seq.decode("latin-1", errors="replace")
        self._unknown_seqs.append(text)
        if len(self._unknown_seqs) > 100:
            self._unknown_seqs.pop(0)

    @property
    def unknown_sequences(self) -> list[str]:
        return list(self._unknown_seqs)

    # ---------- 状态机 ----------

    def _feed_char(self, ch: str) -> None:
        if self._state == GROUND:
            code = ord(ch)
            if ch == "\x1b":  # ESC
                self._state = ESC
                self._raw = bytearray()
            elif ch == "\r":  # CR
                self._cursor_to_col0()
            elif ch == "\n":  # LF
                self._linefeed()
            elif ch == "\x08" or ch == "\x7f":  # BS / DEL
                self._backspace()
            elif code < 0x20 or code == 0x7F:
                pass  # 其它控制字符（BEL/HT 等）忽略
            else:
                self._print(ch)  # ASCII 可打印 + 解码后的非 ASCII 文本（CJK 等）
            return

        if self._state == ESC:
            if ch == "[":
                self._state = CSI_ENTRY
                self._params = []
                self._raw.append(0x5B)
            elif ch == "]":
                self._state = OSC_STR
                self._raw.append(0x5D)
            elif ch == "7":
                self._dec_save()
                self._state = GROUND
            elif ch == "8":
                self._dec_restore()
                self._state = GROUND
            elif ch == "M":
                self._reverse_index()
                self._state = GROUND
            elif ch == "D":
                self._linefeed()
                self._state = GROUND
            elif ch == "E":
                self._next_line()
                self._state = GROUND
            elif ch == "c":
                self._reset()
                self._state = GROUND
            elif ch == "(":  # 字符集选择（不实现）→ 跳过
                self._state = SKIP
                self._skip_final = False
            elif ch == "?":  # 私有 ESC? 序列 → 跳过
                self._state = SKIP
                self._skip_final = True
            else:
                self.unknown_seq(bytes(self._raw))
                self._state = GROUND
            return

        if self._state == CSI_ENTRY:
            code = ord(ch)
            if code < 0x100:
                self._raw.append(code)
            if 0x40 <= code <= 0x7E:  # 终结符
                self._dispatch_csi(ch)
                self._state = GROUND
            elif ch == ";":
                self._params.append(0)
                self._state = CSI_PARAM
            elif 0x30 <= code <= 0x39:
                self._params.append(code - 0x30)
                self._state = CSI_PARAM
            elif ch in ("?", ">"):  # private 前缀 → 跳过
                self._state = SKIP
                self._skip_final = True
            else:
                self._state = CSI_PARAM
            return

        if self._state == CSI_PARAM:
            code = ord(ch)
            if code < 0x100:
                self._raw.append(code)
            if 0x40 <= code <= 0x7E:
                self._dispatch_csi(ch)
                self._state = GROUND
            elif ch == ";":
                self._params.append(0)
            elif 0x30 <= code <= 0x39:
                if len(self._raw) > MAX_PARAM_LEN:
                    self.unknown_seq(bytes(self._raw))
                    self._state = SKIP
                    self._skip_final = True
                else:
                    self._append_digit(code)
            elif ch in ("?", ">"):  # 迟到的 private 前缀
                self._state = SKIP
                self._skip_final = True
            return

        if self._state == OSC_STR:
            if ch == "\x07":  # BEL 终止
                self._state = GROUND
            elif ch == "\x1b":  # ESC 可能开始 ST（ESC \）
                self._state = ESC
            elif len(self._raw) > MAX_PARAM_LEN:
                self.unknown_seq(bytes(self._raw))
                self._state = GROUND
            else:
                self._raw.append(ord(ch))
            return

        if self._state == SKIP:
            if len(self._raw) < MAX_PARAM_LEN:
                self._raw.append(ord(ch))
            if ch == "\x1b":
                self._state = ESC
            elif self._skip_final:
                if 0x40 <= ord(ch) <= 0x7E:
                    self.unknown_seq(bytes(self._raw))
                    self._state = GROUND
            elif 0x20 <= ord(ch) <= 0x7E:  # 字符集选择：下一个可打印字符
                self._state = GROUND
            return

    # ---------- CSI 分派 ----------

    def _dispatch_csi(self, term: str) -> None:
        final = _CSI_DISPATCH.get(term)
        if final is None:
            self.unknown_seq(bytes(self._raw))
            return
        n = self._param(0)
        match final:
            case "cursor_up":
                self._cursor_up(n)
            case "cursor_down":
                self._cursor_down(n)
            case "cursor_forward":
                self._cursor_forward(n)
            case "cursor_back":
                self._cursor_back(n)
            case "set_cursor_col":
                self.buffer.move_cursor_col(self._col1_to_0(n))
            case "set_cursor":
                row = self._param(0) - 1
                col = self._param(1) - 1
                self.buffer.move_cursor(row, col)
            case "erase_in_display":
                self._erase_in_display(n)
            case "erase_in_line":
                self._erase_in_line(n)
            case "sgr":
                self._style = apply_sgr(self._style, self._params)
            case "set_scroll_region":
                self._set_scroll_region()
            case "insert_lines":
                self._insert_lines(n)
            case "delete_lines":
                self._delete_lines(n)
            case "delete_char":
                self._delete_char(n)
            case "erase_char":
                self._erase_char(n)
            case "insert_char":
                self._insert_char(n)
            case "save_cursor_pos":
                self.buffer.save_cursor(self._style)
            case "restore_cursor_pos":
                self._restore_cursor_pos()

    def _param(self, idx: int, default: int = 0) -> int:
        if idx < len(self._params):
            return self._params[idx]
        return default

    def _append_digit(self, code: int) -> None:
        digit = code - 0x30
        if not self._params:
            self._params.append(digit)
        else:
            self._params[-1] = min(self._params[-1] * 10 + digit, 99999)

    def _col1_to_0(self, n: int) -> int:
        return max(0, n - 1)

    # ---------- 基本动作 ----------

    def _print(self, ch: str) -> None:
        self.buffer.write_char(ch, self._style)

    def _cursor_to_col0(self) -> None:
        self.buffer.move_cursor_col(0)

    def _cursor_up(self, n: int) -> None:
        self.buffer.move_cursor(self.buffer.cursor_row - max(1, n), self.buffer.cursor_col)

    def _cursor_down(self, n: int) -> None:
        self.buffer.move_cursor(self.buffer.cursor_row + max(1, n), self.buffer.cursor_col)

    def _cursor_forward(self, n: int) -> None:
        self.buffer.cursor_right(max(1, n))

    def _cursor_back(self, n: int) -> None:
        self.buffer.cursor_left(max(1, n))

    def _backspace(self) -> None:
        self.buffer.cursor_left(1)

    def _linefeed(self) -> None:
        if self.buffer.cursor_row == self._scroll_bottom:
            self._scroll_up(1)
        else:
            self.buffer.move_cursor_row(self.buffer.cursor_row + 1)

    def _next_line(self) -> None:
        self.buffer.move_cursor_col(0)
        self._linefeed()

    def _reverse_index(self) -> None:
        if self.buffer.cursor_row == self._scroll_top:
            self._scroll_down(1)
        else:
            self.buffer.move_cursor_row(self.buffer.cursor_row - 1)

    # ---------- 擦除 ----------

    def _erase_in_display(self, mode: int) -> None:
        rows = self.buffer.row_count()
        cols = self.buffer.col_count()
        row, col = self.buffer.cursor_row, self.buffer.cursor_col
        if mode == 0:
            self.buffer.fill_region(row, col, rows, cols, self._style)
        elif mode == 1:
            self.buffer.fill_region(0, 0, row + 1, col + 1, self._style)
        elif mode == 2:
            self.buffer.fill_region(0, 0, rows, cols, self._style)
        else:
            self.unknown_seq(b"\x1b[?J")

    def _erase_in_line(self, mode: int) -> None:
        cols = self.buffer.col_count()
        row, col = self.buffer.cursor_row, self.buffer.cursor_col
        if mode == 0:
            self.buffer.fill_region(row, col, row + 1, cols, self._style)
        elif mode == 1:
            self.buffer.fill_region(row, 0, row + 1, col + 1, self._style)
        elif mode == 2:
            self.buffer.fill_region(row, 0, row + 1, cols, self._style)
        else:
            self.unknown_seq(b"\x1b[?K")

    # ---------- 滚动区域 ----------

    def _set_scroll_region(self) -> None:
        rows = self.buffer.row_count()
        top = self._param(0, 1)
        bottom = self._param(1, rows)
        top = max(1, min(top, rows))
        bottom = max(1, min(bottom, rows))
        if top > bottom:
            top, bottom = 1, rows
        self._scroll_top = top - 1
        self._scroll_bottom = bottom - 1
        self.buffer.move_cursor(0, 0)  # DECSTBM 将光标移到左上角

    def _scroll_up(self, n: int) -> None:
        top, bottom = self._scroll_top, self._scroll_bottom
        if top > bottom:
            return
        n = max(1, min(n, bottom - top + 1))
        for r in range(top, top + n):
            self.scrollback.push([self.buffer.get_row(r)])
        self.buffer.scroll_up(n, top, bottom)

    def _scroll_down(self, n: int) -> None:
        self.buffer.scroll_down(max(1, n), self._scroll_top, self._scroll_bottom)

    # ---------- 插入/删除 ----------

    def _insert_lines(self, n: int) -> None:
        n = max(1, n)
        top, bottom = self._scroll_top, self._scroll_bottom
        if not (top <= self.buffer.cursor_row <= bottom):
            return
        n = min(n, bottom - top + 1)
        for r in range(bottom, top + n - 1, -1):
            for c in range(self.buffer.col_count()):
                self.buffer.set_cell(r, c, self.buffer.get_cell(r - n, c))
        for r in range(top, top + n):
            self.buffer.fill_row(r, self._style)

    def _delete_lines(self, n: int) -> None:
        n = max(1, n)
        top, bottom = self._scroll_top, self._scroll_bottom
        if not (top <= self.buffer.cursor_row <= bottom):
            return
        n = min(n, bottom - top + 1)
        for r in range(top, bottom - n + 1):
            for c in range(self.buffer.col_count()):
                self.buffer.set_cell(r, c, self.buffer.get_cell(r + n, c))
        for r in range(bottom - n + 1, bottom + 1):
            self.buffer.fill_row(r, self._style)

    def _delete_char(self, n: int) -> None:
        row, col = self.buffer.cursor_row, self.buffer.cursor_col
        cols = self.buffer.col_count()
        n = max(1, min(n, cols - col))
        for c in range(col, cols - n):
            self.buffer.set_cell(row, c, self.buffer.get_cell(row, c + n))
        for c in range(cols - n, cols):
            self.buffer.set_cell(row, c, sb.Cell.blank(self._style))

    def _erase_char(self, n: int) -> None:
        row, col = self.buffer.cursor_row, self.buffer.cursor_col
        cols = self.buffer.col_count()
        for c in range(col, min(col + n, cols)):
            self.buffer.set_cell(row, c, sb.Cell.blank(self._style))

    def _insert_char(self, n: int) -> None:
        row, col = self.buffer.cursor_row, self.buffer.cursor_col
        cols = self.buffer.col_count()
        n = max(1, min(n, cols - col))
        for c in range(cols - 1, col + n - 1, -1):
            self.buffer.set_cell(row, c, self.buffer.get_cell(row, c - n))
        for c in range(col, col + n):
            self.buffer.set_cell(row, c, sb.Cell.blank(self._style))

    # ---------- DEC 兼容 ----------

    def _dec_save(self) -> None:
        self.buffer.save_cursor(self._style)

    def _dec_restore(self) -> None:
        style = self.buffer.restore_cursor()
        if style is not None:
            self._style = style

    def _restore_cursor_pos(self) -> None:
        style = self.buffer.restore_cursor()
        if style is not None:
            self._style = style

    def _reset(self) -> None:
        self._style = SgrState()
        self._scroll_top = 0
        self._scroll_bottom = self.buffer.row_count() - 1
        self.buffer.fill_region(0, 0, self.buffer.row_count(), self.buffer.col_count(), self._style)
        self.buffer.move_cursor(0, 0)
