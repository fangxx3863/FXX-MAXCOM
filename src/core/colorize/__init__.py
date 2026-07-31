"""自动染色模块（COLOR）。

规则链执行 + 内置规则 + 用户规则加载 + ANSI 让位 + 调色板。与 ANSI 解析器互补：
无 ANSI 时按预设规则着色，检测到 ANSI 自动让位（INV-1）。
"""

from core.colorize.builtin_rules import (
    BUILTIN_RULES,
    KV_COLOR,
    LEVEL_BRACKET_RE,
    LEVEL_KEYWORD_RE,
    NUM_COLOR,
    NUM_RE,
    bracket_rule,
    keyword_rule,
    kv_rule,
    number_rule,
)
from core.colorize.engine import ANSI_RE, ColoredSegment, ColorizeEngine, contains_ansi
from core.colorize.loader import load_rules, register_user_rule
from core.colorize.palette import Palette

__all__ = [
    "ANSI_RE",
    "BUILTIN_RULES",
    "KV_COLOR",
    "LEVEL_BRACKET_RE",
    "LEVEL_KEYWORD_RE",
    "NUM_COLOR",
    "NUM_RE",
    "ColoredSegment",
    "ColorizeEngine",
    "Palette",
    "bracket_rule",
    "contains_ansi",
    "keyword_rule",
    "kv_rule",
    "load_rules",
    "number_rule",
    "register_user_rule",
]
