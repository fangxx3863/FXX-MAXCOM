"""交互式终端模块测试（TERM-T01..T08 DoD 全覆盖）。

GUI 部分（TerminalViewport）需要 DPG context；纯逻辑部分 headless 可测。
"""

import dearpygui.dearpygui as dpg
import pytest

from core.ansi.parser import AnsiParser
from core.ansi.screen_buffer import Cell, ScreenBuffer
from core.ansi.sgr import SgrState
from core.terminal.echo import LocalEcho
from core.terminal.keymap import (
    KEY_BACK,
    KEY_DOWN,
    KEY_ESCAPE,
    KEY_LEFT,
    KEY_RETURN,
    KEY_RIGHT,
    KEY_TAB,
    KEY_UP,
    KeyMapConfig,
    on_key,
)
from core.terminal.paste import PasteManager
from core.terminal.search import search_in_cells
from core.terminal.selection import TextSelection
from ui.terminal_viewport import TerminalViewport, _bg, _fg


@pytest.fixture()
def dpg_ctx() -> None:
    dpg.create_context()
    yield
    dpg.destroy_context()


def make_buffer(rows: int = 5, cols: int = 20) -> ScreenBuffer:
    return ScreenBuffer(rows, cols)


# ---------- TERM-T02: 击键直传 ----------


def test_key_printable() -> None:
    assert on_key(0x41, 0, KeyMapConfig()) == b"A"
    assert on_key(0x61, 0, KeyMapConfig()) == b"a"


def test_key_shift_upper() -> None:
    assert on_key(0x61, 0x2000, KeyMapConfig()) == b"A"  # mvKey_ModShift


def test_key_ctrl_prioritized() -> None:
    assert on_key(0x63, 0x1000, KeyMapConfig()) == b"\x03"  # Ctrl+C (mvKey_ModCtrl)
    assert on_key(0x64, 0x1000, KeyMapConfig()) == b"\x04"  # Ctrl+D
    assert on_key(0x7A, 0x1000, KeyMapConfig()) == b"\x1a"  # Ctrl+Z


def test_key_enter_modes() -> None:
    assert on_key(KEY_RETURN, 0, KeyMapConfig(enter="crlf")) == b"\x0d\x0a"
    assert on_key(KEY_RETURN, 0, KeyMapConfig(enter="cr")) == b"\x0d"
    assert on_key(KEY_RETURN, 0, KeyMapConfig(enter="lf")) == b"\x0a"


def test_key_backspace_modes() -> None:
    assert on_key(KEY_BACK, 0, KeyMapConfig(backspace="del")) == b"\x7f"
    assert on_key(KEY_BACK, 0, KeyMapConfig(backspace="bs")) == b"\x08"


def test_key_arrow_sequences() -> None:
    # DPG 方向键 key id：Up/Down/Left/Right = 0x203/0x204/0x201/0x202
    assert on_key(KEY_UP, 0, KeyMapConfig()) == b"\x1b[A"
    assert on_key(KEY_DOWN, 0, KeyMapConfig()) == b"\x1b[B"
    assert on_key(KEY_LEFT, 0, KeyMapConfig()) == b"\x1b[D"
    assert on_key(KEY_RIGHT, 0, KeyMapConfig()) == b"\x1b[C"


def test_key_tab() -> None:
    assert on_key(KEY_TAB, 0, KeyMapConfig()) == b"\x09"


def test_key_esc() -> None:
    assert on_key(KEY_ESCAPE, 0, KeyMapConfig()) == b"\x1b"


def test_key_unknown_returns_empty() -> None:
    assert on_key(0x12, 0x1000, KeyMapConfig()) == b""  # Ctrl+非字母


# ---------- TERM-T03: 本地回显 ----------


def test_echo_disabled_by_default() -> None:
    echo = LocalEcho()
    assert not echo.enabled
    assert echo.on_input("A") == ""


def test_echo_printable() -> None:
    echo = LocalEcho(enabled=True)
    assert echo.on_input("A") == "A"
    assert echo.on_input("中") == "中"


def test_echo_backspace() -> None:
    echo = LocalEcho(enabled=True)
    echo.on_input("A")
    echo.on_input("B")
    assert echo.on_input("\x7f") == "\b \b"
    assert echo.on_input("\x08") == "\b \b"


def test_echo_backspace_empty() -> None:
    echo = LocalEcho(enabled=True)
    assert echo.on_input("\x7f") == ""


def test_echo_enter() -> None:
    echo = LocalEcho(enabled=True)
    echo.on_input("A")
    assert echo.on_input("\r") == "\r\n"


def test_echo_ctrl_not_shown() -> None:
    echo = LocalEcho(enabled=True)
    assert echo.on_input("\x03") == ""  # Ctrl+C 不回显
    assert echo.on_input("\x1b") == ""


def test_echo_disable_clears_line() -> None:
    echo = LocalEcho(enabled=True)
    echo.on_input("A")
    echo.set_enabled(False)
    assert echo.on_input("B") == ""
    assert echo.on_input("C") == ""


# ---------- TERM-T04: 文本选择 ----------


def _row_cells(text: str, cols: int) -> list[Cell]:
    cells = [Cell.blank() for _ in range(cols)]
    for i, ch in enumerate(text):
        cells[i] = Cell(ch, SgrState())
    return cells


def test_selection_basic() -> None:
    rows = [_row_cells("Hello", 10), _row_cells("World", 10)]
    sel = TextSelection(lambda r: rows[r])
    sel.begin((0, 1))
    sel.extend((0, 4))
    assert sel.active
    text = sel.copy_to_clipboard()
    assert text == "ello"


def test_selection_multi_line() -> None:
    rows = [_row_cells("Hello", 10), _row_cells("World", 10)]
    sel = TextSelection(lambda r: rows[r])
    sel.begin((0, 0))
    sel.extend((1, 4))
    assert sel.copy_to_clipboard() == "Hello\nWorld"


def test_selection_rect_bounds() -> None:
    rows = [_row_cells("Hello", 10), _row_cells("World", 10)]
    sel = TextSelection(lambda r: rows[r])
    sel.begin((1, 3))
    sel.extend((0, 1))
    assert sel.bounds() == (0, 1, 1, 3)


def test_selection_no_cjk_half_char() -> None:
    # 宽字符"世"占两列，选择含占位列时不应截出半个
    cells = [Cell.blank() for _ in range(6)]
    cells[0] = Cell("世", SgrState())
    cells[1] = Cell(" ", SgrState())  # 占位列
    cells[2] = Cell("A", SgrState())
    sel = TextSelection(lambda r: cells if r == 0 else [])
    sel.begin((0, 0))
    sel.extend((0, 2))
    assert sel.copy_to_clipboard() == "世A"


def test_selection_inactive_empty() -> None:
    sel = TextSelection(lambda r: [])
    assert sel.copy_to_clipboard() == ""
    assert sel.render_highlight() == set()


# ---------- TERM-T05: 粘贴 ----------


def test_paste_lines_and_delay() -> None:
    sent: list[bytes] = []
    pm = PasteManager(sent.append)
    pm.set_delay_ms(0)
    pm.paste("ab\ncd\nef")
    pm.close()
    pm._worker.join(timeout=2)
    assert sent == [b"ab\r\n", b"cd\r\n", b"ef"]


def test_paste_abort() -> None:
    sent: list[bytes] = []
    pm = PasteManager(sent.append)
    pm.set_delay_ms(50)
    pm.paste("a\nb\nc\nd")
    pm.abort()
    pm.close()
    pm._worker.join(timeout=2)
    assert sent == []  # 全部被清空


def test_paste_keeps_empty_lines() -> None:
    sent: list[bytes] = []
    pm = PasteManager(sent.append)
    pm.set_delay_ms(0)
    pm.paste("a\n\nb")
    pm.close()
    pm._worker.join(timeout=2)
    assert sent == [b"a\r\n", b"\r\n", b"b"]


# ---------- TERM-T06: 回滚上滚查看 ----------


def test_scroll_offset_bounded(dpg_ctx: None) -> None:
    buf = make_buffer()
    view = TerminalViewport(0, buf, cols=20, rows=5)
    view.scroll_view(-5)
    assert view.scroll_offset == 0  # 无回滚，不能上滚


def test_scroll_to_bottom_follows(dpg_ctx: None) -> None:
    buf = make_buffer()
    view = TerminalViewport(0, buf, cols=20, rows=5)
    view.scroll_view(100)  # 越界钳制到回滚上限
    view.scroll_to_bottom()
    assert view.follow_output()


# ---------- TERM-T07: 光标 ----------


def test_cursor_visibility(dpg_ctx: None) -> None:
    buf = make_buffer()
    view = TerminalViewport(0, buf, cols=20, rows=5)
    assert view._cursor_visible
    view.set_cursor_visible(False)
    assert not view._cursor_visible


# ---------- TERM-T08: 回滚搜索 ----------


def test_search_finds_matches() -> None:
    rows = [_row_cells("hello world", 20), _row_cells("say hello again", 20)]
    hits = list(search_in_cells(rows, "hello"))
    assert hits == [(0, 0), (1, 4)]


def test_search_no_match() -> None:
    rows = [_row_cells("abc", 5)]
    assert list(search_in_cells(rows, "xyz")) == []


def test_search_empty_query() -> None:
    rows = [_row_cells("abc", 5)]
    assert list(search_in_cells(rows, "")) == []
    assert list(search_in_cells(rows, "   ")) == []


def test_search_cjk() -> None:
    cells = [Cell.blank() for _ in range(6)]
    cells[0] = Cell("世", SgrState())
    cells[1] = Cell(" ", SgrState())
    cells[2] = Cell("界", SgrState())
    cells[3] = Cell(" ", SgrState())
    hits = list(search_in_cells([cells], "世界"))
    assert hits == [(0, 0)]


# ---------- TERM-T01: 渲染取色 ----------


def test_sgr_fg_basic() -> None:
    assert _fg(SgrState(fg=1)) == (0xCC, 0x00, 0x00)


def test_sgr_fg_truecolor() -> None:
    assert _fg(SgrState(fg=(10, 20, 30))) == (10, 20, 30)


def test_sgr_reverse_swaps() -> None:
    assert _fg(SgrState(fg=1, bg=4, reverse=True)) == (0x00, 0x00, 0xCC)
    assert _bg(SgrState(fg=1, bg=4, reverse=True)) == (0xCC, 0x00, 0x00)


def test_sgr_default_colors() -> None:
    assert _fg(SgrState()) == (220, 220, 224)
    assert _bg(SgrState()) == (16, 16, 20)


def test_viewport_render_no_crash(dpg_ctx: None) -> None:
    with dpg.window():
        dpg.add_child_window(tag="term_parent")
    p = AnsiParser(rows=5, cols=20)
    p.feed(b"\x1b[31mHello\x1b[0m World")
    view = TerminalViewport("term_parent", p.buffer, p.scrollback, cols=20, rows=5)
    view.render()
    assert dpg.does_item_exist(view._draw)
    view.render_cursor(blink_on=True)
    view.render_cursor(blink_on=False)


def test_viewport_render_cjk(dpg_ctx: None) -> None:
    with dpg.window():
        dpg.add_child_window(tag="term_cjk_parent")
    p = AnsiParser(rows=5, cols=20)
    p.feed("你好世界".encode())
    view = TerminalViewport("term_cjk_parent", p.buffer, p.scrollback, cols=20, rows=5)
    view.render()  # 不应崩溃，CJK 段合并渲染
