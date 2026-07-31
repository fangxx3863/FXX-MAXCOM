"""ANSI 解析引擎（ANS 模块）。

纯 Python 状态机，无 GUI 依赖。核心子集：SGR + 光标 + 滚动区域 + 清屏（ADR-0001）。
消费方：TERM 模块（交互式终端 Viewport）。
"""

from core.ansi.parser import AnsiParser
from core.ansi.screen_buffer import Cell, ScreenBuffer, is_wide_char
from core.ansi.scrollback import ScrollbackBuffer
from core.ansi.sgr import SgrState, apply_sgr
from core.ansi.strip import strip_ansi

__all__ = [
    "AnsiParser",
    "Cell",
    "ScreenBuffer",
    "ScrollbackBuffer",
    "SgrState",
    "apply_sgr",
    "is_wide_char",
    "strip_ansi",
]
