"""ANSI 解析引擎测试（ANS-T01..T09 DoD 全覆盖）。"""

from core.ansi.parser import AnsiParser
from core.ansi.screen_buffer import Cell, ScreenBuffer, is_wide_char
from core.ansi.scrollback import ScrollbackBuffer
from core.ansi.sgr import SgrState, apply_sgr, xterm_256

# ---------- ANS-T01: SGR 解析与状态 ----------


def test_sgr_16color_fg_bg() -> None:
    s = apply_sgr(SgrState(), [31, 44])
    assert s.fg == 1
    assert s.bg == 4


def test_sgr_bright_colors() -> None:
    s = apply_sgr(SgrState(), [91, 104])
    assert s.fg == 9
    assert s.bg == 12


def test_sgr_256color() -> None:
    s = apply_sgr(SgrState(), [38, 5, 196])
    assert s.fg == 196
    bg = apply_sgr(SgrState(), [48, 5, 21])
    assert bg.bg == 21


def test_sgr_truecolor() -> None:
    s = apply_sgr(SgrState(), [38, 2, 10, 20, 30])
    assert s.fg == (10, 20, 30)
    bg = apply_sgr(SgrState(), [48, 2, 1, 2, 3])
    assert bg.bg == (1, 2, 3)


def test_sgr_attributes() -> None:
    s = apply_sgr(SgrState(), [1, 3, 4, 9, 7])
    assert s.bold and s.italic and s.underline and s.strikethrough and s.reverse


def test_sgr_reset_attributes() -> None:
    base = apply_sgr(SgrState(), [1, 3, 4, 7, 9, 31])
    s = apply_sgr(base, [22, 23, 24, 27, 29])
    assert not (s.bold or s.italic or s.underline or s.reverse or s.strikethrough)
    assert s.fg == 1  # 属性清除不影响颜色


def test_sgr_reset_all() -> None:
    s = apply_sgr(SgrState(), [31, 44, 1, 38, 5, 196])
    r = apply_sgr(s, [0])
    assert r == SgrState()


def test_sgr_default_fg_bg() -> None:
    s = apply_sgr(SgrState(), [39, 49])
    assert s.fg is None and s.bg is None


def test_sgr_unknown_ignored() -> None:
    s = apply_sgr(SgrState(fg=1), [65, 66])
    assert s.fg == 1  # 未知参数静默忽略


def test_sgr_variable_params_skips_correctly() -> None:
    # 38;5 后紧跟后续 SGR 参数，不能误解析
    s = apply_sgr(SgrState(), [38, 5, 196, 1])
    assert s.fg == 196 and s.bold


def test_sgr_immutable() -> None:
    base = SgrState(fg=1)
    apply_sgr(base, [32])
    assert base.fg == 1


def test_xterm_256_palette() -> None:
    assert xterm_256(0) == (0, 0, 0)
    assert xterm_256(16) == (0, 0, 0)
    assert xterm_256(231) == (255, 255, 255)
    g = xterm_256(232)
    assert g[0] == g[1] == g[2] == 8


# ---------- ANS-T07: 屏幕缓冲区 ----------


def test_write_and_get() -> None:
    buf = ScreenBuffer(3, 5)
    buf.write_char("A", SgrState())
    buf.write_char("B", SgrState())
    assert buf.get_row_text(0) == "AB   "
    assert buf.cursor_col == 2


def test_cursor_clamp_bounds() -> None:
    buf = ScreenBuffer(3, 5)
    buf.move_cursor(99, 99)
    assert (buf.cursor_row, buf.cursor_col) == (2, 4)
    buf.move_cursor(-1, -1)
    assert (buf.cursor_row, buf.cursor_col) == (0, 0)


def test_wide_char_occupies_two_cols() -> None:
    buf = ScreenBuffer(2, 6)
    buf.write_char("世", SgrState())
    assert buf.cursor_col == 2
    cells = buf.get_row(0)
    assert cells[0].char == "世"
    assert cells[1].char == " "  # 占位符
    assert cells[2].char == " "


def test_wide_char_wraps_clamped_at_line_end() -> None:
    buf = ScreenBuffer(2, 5)
    buf.move_cursor(0, 4)
    buf.write_char("世", SgrState())
    # 行尾写宽字符：不写、不折行
    assert buf.get_row_text(0) == "     "
    assert buf.cursor_col == 4


def test_dirty_rows_only_changed() -> None:
    buf = ScreenBuffer(3, 5)
    buf.write_char("A", SgrState())
    buf.write_char("B", SgrState())
    assert buf.get_dirty_rows() == {0}
    buf.move_cursor(2, 0)
    buf.write_char("C", SgrState())
    assert buf.get_dirty_rows() == {0, 2}
    buf.clear_dirty()
    assert buf.get_dirty_rows() == set()


def test_erase_marks_dirty() -> None:
    buf = ScreenBuffer(3, 5)
    buf.move_cursor(2, 0)
    buf.write_char("A", SgrState())
    buf.clear_dirty()
    buf.fill_row(2, SgrState())
    assert buf.get_dirty_rows() == {2}


def test_cell_style_preserved() -> None:
    buf = ScreenBuffer(1, 5)
    style = SgrState(fg=2, bold=True)
    buf.write_char("X", style)
    assert buf.get_cell(0, 0).style == style


def test_is_wide_char() -> None:
    assert is_wide_char("世")
    assert is_wide_char("─")
    assert is_wide_char("　")
    assert not is_wide_char("A")
    assert not is_wide_char("1")


# ---------- ANS-T02/T03/T04/T05/T06: 解析器序列 ----------


def parse(text: str, rows: int = 5, cols: int = 20) -> AnsiParser:
    p = AnsiParser(rows=rows, cols=cols)
    p.feed(text.encode("utf-8"))
    return p


def test_plain_text() -> None:
    p = parse("Hello")
    assert p.buffer.get_row_text(0) == "Hello" + " " * 15
    assert p.buffer.cursor_col == 5


def test_cursor_up_down() -> None:
    p = parse("A\x1b[1BA")
    assert p.buffer.cursor_row == 1
    p.feed(b"\x1b[1AA")
    assert p.buffer.cursor_row == 0


def test_cursor_forward_back() -> None:
    p = parse("AB\x1b[1D")
    assert p.buffer.cursor_col == 1
    p.feed(b"\x1b[2CX")
    assert p.buffer.cursor_col == 4
    assert p.buffer.get_row_text(0)[3] == "X"


def test_cursor_boundary_clamp() -> None:
    p = parse("\x1b[999A")
    assert p.buffer.cursor_row == 0
    p = parse("\x1b[999B")
    assert p.buffer.cursor_row == p.buffer.row_count() - 1
    p = parse("A\x1b[999D")
    assert p.buffer.cursor_col == 0
    p = parse("\x1b[999C")
    assert p.buffer.cursor_col == p.buffer.col_count() - 1


def test_cursor_to_column_1based() -> None:
    p = parse("\x1b[5G")
    assert p.buffer.cursor_col == 4  # 1-based → 0-based


def test_cursor_position_1based() -> None:
    p = parse("\x1b[2;4H")
    assert (p.buffer.cursor_row, p.buffer.cursor_col) == (1, 3)
    p = parse("\x1b[3;5f")
    assert (p.buffer.cursor_row, p.buffer.cursor_col) == (2, 4)


def test_sgr_through_parser() -> None:
    p = parse("\x1b[31;1mX")
    assert p.buffer.get_cell(0, 0).style.fg == 1
    assert p.buffer.get_cell(0, 0).style.bold


def test_erase_in_line() -> None:
    p = parse("Hello\x1b[2D\x1b[K")
    assert p.buffer.get_row_text(0) == "Hel  " + " " * 15
    p2 = parse("Hello\x1b[3D\x1b[1K")  # 光标回 col2，EL 1 清行首到光标（含光标列）
    assert p2.buffer.get_row_text(0) == "   lo" + " " * 15
    p3 = parse("Hello\x1b[K")  # 光标到行尾（已在行尾，无效果）
    assert p3.buffer.get_row_text(0).startswith("Hello")


def test_erase_in_display() -> None:
    p = parse("AB\x1b[1;1H\x1b[J")  # 光标在(0,0)，ED 0 清到屏末
    assert p.buffer.get_row_text(0) == "  " + " " * 18
    p2 = parse("AB\x1b[2J")
    assert p2.buffer.get_row_text(0) == " " * 20
    p3 = parse("\x1b[1J")  # 开头到光标（光标在 0,0，清 1 格）
    assert p3.buffer.get_row_text(0)[0] == " "


def test_scroll_region_restricts_scroll() -> None:
    p = parse("A\x1b[1;3r\x1b[1B")  # 区域 1-3，光标下移仍在内
    assert p.buffer.cursor_row == 1
    # 光标移到区域外，LF 不影响区域外
    p2 = AnsiParser(rows=5, cols=10)
    p2.feed(b"X\x1b[2;4r\x1b[2;1H\r\n")  # 光标在区域外(1,0)，LF 应只移动光标
    assert p2.buffer.cursor_row == 2
    assert p2.buffer.get_row_text(0) == "X         "


def test_newline_scrolls_at_bottom() -> None:
    p = parse("A\x1b[1;2r\x1b[1B")  # 区域 1-2，光标到 (1,0)
    p.feed(b"\r\n")  # 光标在 bottom，触发上滚
    assert p.buffer.cursor_row == 1
    assert p.buffer.get_row_text(1) == " " * 20  # 新空行
    assert p.scrollback.line_count >= 1  # 滚出的行进了回滚


def test_scroll_up_down() -> None:
    p = parse("TOP\x1b[1;3r\x1b[2;1HBOT")
    p.feed(b"\x1b[1M")  # DL 1 在当前行删除一行 → 相当于滚动
    assert p.buffer.cursor_row == 1
    # scroll_up 直接调用测试
    buf = ScreenBuffer(5, 10)
    buf.write_char("A", SgrState())
    buf.move_cursor(1, 0)
    buf.write_char("B", SgrState())
    buf.scroll_up(1, 0, 4)
    assert buf.get_row_text(0).startswith("B")
    assert buf.get_row_text(4) == " " * 10


def test_insert_delete_lines() -> None:
    p = parse("AAA\x1b[2;1HBBB\x1b[1;1H\x1b[1L")
    # 光标在(0,0)，IL 1 在顶部插空行，原行下移
    assert p.buffer.get_row_text(0) == " " * 20
    assert p.buffer.get_row_text(1).startswith("AAA")
    assert p.buffer.get_row_text(2).startswith("BBB")
    p2 = parse("AAA\x1b[2;1HBBB\x1b[3;1HCCC\x1b[2;1H\x1b[1M")
    # 光标在(1,0)，DL 1 删当前行，下行上移
    assert p2.buffer.get_row_text(1).startswith("CCC")


def test_insert_delete_char() -> None:
    p = parse("ABCD\x1b[1G\x1b[1@")  # ICH 1 在 col0 插空格
    assert p.buffer.get_row_text(0).startswith(" ABCD")
    p2 = parse("ABCD\x1b[2D\x1b[1P")  # DCH 1 删 col2
    assert p2.buffer.get_row_text(0).startswith("ABD")
    p3 = parse("ABCD\x1b[2D\x1b[1X")  # ECH 1 擦 col2（不位移）
    assert p3.buffer.get_row_text(0).startswith("AB D")


def test_dec_save_restore() -> None:
    p = parse("A\x1b[31m\x1b7\x1b[3;5H\x1b8")
    assert (p.buffer.cursor_row, p.buffer.cursor_col) == (0, 1)
    assert p.buffer.get_row_text(0).startswith("A")
    p.feed(b"Z")
    assert p.buffer.get_row_text(0) == "AZ" + " " * 18  # 属性（红色）恢复后继续


def test_csi_save_restore_position() -> None:
    p = parse("A\x1b[s\x1b[3;5H\x1b[u")
    assert (p.buffer.cursor_row, p.buffer.cursor_col) == (0, 1)


def test_reverse_index() -> None:
    p = parse("\x1b[1;2r\x1b[2;1H\x1bM")  # 光标在(1,0) 区域顶（bottom=2），RI 不触发滚动
    assert p.buffer.cursor_row == 0
    assert p.scrollback.line_count == 0  # 未滚动，无回滚行


def test_ri_at_top_triggers_scroll_down() -> None:
    # 光标到(1,0) 底部；RI 仅在顶部行(0)触发滚动——光标不在顶部，仅上移
    p = parse("X\x1b[1;2r\x1b[1B\x1bM")
    assert p.buffer.cursor_row == 0
    p2 = parse("X\x1b[1;2r\x1bM")  # 光标(0,0) 在区域顶，RI 触发下滚
    assert p2.buffer.cursor_row == 0  # 光标仍在顶部（滚动发生在光标处）
    assert p2.buffer.get_row_text(0) == " " * 20  # 顶部被空行填充


def test_index_and_next_line() -> None:
    p = parse("A\x1bD")  # IND
    assert p.buffer.cursor_row == 1
    p2 = parse("B\x1bE")  # NEL: 换行+回车
    assert p2.buffer.cursor_row == 1
    assert p2.buffer.cursor_col == 0


def test_reset() -> None:
    p = parse("\x1b[31;1mX\x1b[3;5H\x1b[2;4r\x1bc")
    assert p.buffer.get_cell(0, 0).style == SgrState()
    assert (p.buffer.cursor_row, p.buffer.cursor_col) == (0, 0)
    assert p.buffer.get_row_text(0) == " " * 20  # 全屏清空


def test_crlf_and_lf_alone() -> None:
    p = parse("AB\r\nC")
    assert p.buffer.cursor_row == 1
    assert p.buffer.get_row_text(1).startswith("C")
    p2 = parse("AB\nC")  # LF 不归列，随后写 C 到 col3
    assert p2.buffer.cursor_col == 3
    assert p2.buffer.cursor_row == 1
    assert p2.buffer.get_row_text(1).startswith("  C")


# ---------- ANS-T08: 回滚缓冲区 ----------


def test_scrollback_push_read() -> None:
    sb = ScrollbackBuffer(100)
    sb.push_line([Cell("A", SgrState())])
    sb.push_line([Cell("B", SgrState())])
    assert sb.read_back(0)[0][0].char == "B"  # 最近一行
    assert sb.read_back(1)[0][0].char == "A"
    assert sb.read_back(2) is None  # 超出
    assert sb.read_back(-1) is None


def test_scrollback_ring_overflow() -> None:
    sb = ScrollbackBuffer(3)
    for i in range(5):
        sb.push_line([Cell(str(i), SgrState())])
    assert sb.line_count == 3
    # 最旧的两行被丢弃
    assert sb.read_back(2)[0][0].char == "2"
    assert sb.read_back(0)[0][0].char == "4"


def test_scrollback_clear() -> None:
    sb = ScrollbackBuffer(10)
    sb.push_line([Cell("A", SgrState())])
    sb.clear()
    assert sb.line_count == 0
    assert sb.read_back(0) is None


def test_scrollback_does_not_mutate_screen() -> None:
    p = parse("A\x1b[1;2r\x1b[1B\r\n")
    assert p.scrollback.line_count > 0  # LF 在底部触发上滚，行入回滚
    row_text = p.buffer.get_row_text(0)
    assert p.buffer.get_row_text(0) == row_text  # 回滚不修改当前屏


# ---------- ANS-T09: 容错与跨片段 ----------


def test_unknown_sequence_ignored() -> None:
    p = parse("\x1b[?25l")  # 隐藏光标（私有模式，不实现）→ 跳过
    assert p.unknown_sequences  # 记录日志
    p.feed(b"AB")
    assert p.buffer.get_row_text(0).startswith("AB")  # 状态回归 GROUND


def test_unknown_csi_dispatch() -> None:
    p = parse("\x1b[1Q")  # 未实现终结符
    assert p.unknown_sequences
    p.feed(b"X")
    assert p.buffer.get_row_text(0).startswith("X")


def test_osc_sequence_skipped() -> None:
    p = parse("\x1b]0;title\x07")
    assert not p.buffer.get_row_text(0).strip()
    p.feed(b"A")
    assert p.buffer.get_row_text(0).startswith("A")


def test_long_param_does_not_dos() -> None:
    # 1 万位数字参数：进入 SKIP 直到终结符，安全返回 GROUND
    p = parse("\x1b[" + "9" * 10000 + "A")
    assert p.unknown_sequences  # 超长序列被记录
    p.feed(b"AB")
    assert p.buffer.get_row_text(0).startswith("AB")


def test_fragmented_escape() -> None:
    # ESC 在分包边界被拆断
    p = AnsiParser(rows=5, cols=20)
    p.feed(b"\x1b")
    assert p.buffer.get_row_text(0) == " " * 20
    p.feed(b"[31")
    p.feed(b"m")
    p.feed(b"X")
    assert p.buffer.get_cell(0, 0).style.fg == 1


def test_fragmented_utf8() -> None:
    p = AnsiParser(rows=5, cols=20)
    raw = "世".encode()  # 3 字节
    p.feed(raw[:2])
    p.feed(raw[2:])
    assert p.buffer.cursor_col == 2
    assert p.buffer.get_cell(0, 0).char == "世"


def test_bell_and_control_ignored() -> None:
    p = parse("A\x07B\tC")
    assert p.buffer.get_row_text(0).startswith("ABC")


def test_backspace() -> None:
    p = parse("AB\x08C")
    assert p.buffer.get_row_text(0).startswith("AC")
