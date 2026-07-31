"""ANSI 序列剥离测试（日志路径控制码清理）。"""

from __future__ import annotations

from core.ansi.strip import strip_ansi


def test_strip_sgr() -> None:
    assert strip_ansi("\x1b[31mred\x1b[0m") == "red"
    assert strip_ansi("\x1b[35mbin\x1b[0m") == "bin"


def test_strip_keep_plain_text() -> None:
    assert strip_ansi("plain text") == "plain text"
    assert strip_ansi("") == ""


def test_strip_ansi_prompt_with_text() -> None:
    assert strip_ansi("\x1b[36mroot@board:~$ \x1b[0m") == "root@board:~$ "
    assert strip_ansi("\x1b[31m[E]\x1b[0m timeout") == "[E] timeout"


def test_strip_multiple_sequences() -> None:
    assert strip_ansi("\x1b[1;31mbold red\x1b[0m") == "bold red"


def test_strip_truecolor() -> None:
    assert strip_ansi("\x1b[38;2;255;0;0mX\x1b[0m") == "X"


def test_strip_cursor_moves() -> None:
    assert strip_ansi("\x1b[2J") == ""
    assert strip_ansi("\x1b[10;10H") == ""


def test_strip_esc_2char() -> None:
    assert strip_ansi("\x1bcreset") == "reset"


def test_strip_osc() -> None:
    assert strip_ansi("\x1b]0;title\x07text") == "text"
    assert strip_ansi("\x1b]2;path\x1b\\tail") == "tail"


def test_strip_trailing_lone_esc() -> None:
    assert strip_ansi("text\x1b") == "text"


def test_strip_incomplete_csi() -> None:
    assert strip_ansi("\x1b[35m") == ""  # 行尾残缺 CSI，吞到行尾


def test_strip_ansi_roundtrip_preserves_cjk() -> None:
    assert strip_ansi("\x1b[32m你好世界\x1b[0m") == "你好世界"
