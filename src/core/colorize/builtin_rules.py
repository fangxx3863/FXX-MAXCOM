"""自动染色内置规则（COLOR-T02/T03/T04）。

四条规则按优先级组成规则链（level=1 keyword=2 kv=3 number=4）：
1. 等级括号 `[D] [I] [W] [E] [F] [DEBUG]...` → 整行染色（target=line）
2. 等级关键词 `DEBUG: WARN:` / `<E>` → 整行染色（target=line）
3. 键值对 `KEY: VALUE` → 冒号后 VALUE 用强调色
4. 数值高亮 `0x..` / 浮点 / 整数 → 强调色

颜色映射：D=灰 I=默认 W=黄 E=红 F=红+粗体（SPEC §2.2）。
每条规则独立开关（engine.enable_rule）。不改原文，只分段附色。
"""

from __future__ import annotations

import re

from core.colorize.engine import BuiltinFunc, ColoredSegment

# 等级 → 颜色（D灰 I默认 W黄 E红 F红+粗）。I/INFO 默认色 → fg=None。
# 注意：SPEC §2.1 等级表含 [E]，任务卡正则 [DIFW] 缺 E 系笔误，以 SPEC 表为准。
LEVEL_BRACKET_RE = re.compile(
    r"^\s*\[([DIFWE]|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL)\]", re.IGNORECASE
)

# 关键词规则：关键词后必须跟 `:`/`>`/空白 分隔符，避免 "error handler" 正文误匹配（DoD③）。
LEVEL_KEYWORD_RE = re.compile(
    r"(?:^\s*|^<)(DEBUG|INFO|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|D|I|W|E|F)[:>\s]+",
    re.IGNORECASE,
)

KV_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*):\s*([^,\s]+)")

NUM_RE = re.compile(r"(0x[0-9A-Fa-f]+|\d+\.\d+|\d+)")

_LEVEL_GRAY = {"D", "DEBUG"}
_LEVEL_YELLOW = {"W", "WARN", "WARNING"}
_LEVEL_RED = {"E", "ERROR", "ERR", "F"}
_LEVEL_RED_BOLD = {"F", "FATAL", "CRITICAL"}


def _level_style(level: str) -> tuple[str | None, bool]:
    """等级 → (颜色, 粗体)。I/INFO 默认色返回 (None, False)。"""
    u = level.upper()
    if u in _LEVEL_GRAY:
        return ("gray", False)
    if u in _LEVEL_YELLOW:
        return ("yellow", False)
    if u in _LEVEL_RED or u in _LEVEL_RED_BOLD:
        return ("red", u in _LEVEL_RED_BOLD)
    return (None, False)


def bracket_rule(line: str) -> ColoredSegment | None:
    """等级括号规则（COLOR-T02）：`[W] ...` 整行染色。"""
    m = LEVEL_BRACKET_RE.match(line)
    if m is None:
        return None
    color, bold = _level_style(m.group(1))
    return ColoredSegment(line, color, None, bold)


def keyword_rule(line: str) -> ColoredSegment | None:
    """等级关键词规则（COLOR-T03）：`WARN: ...` / `<E> ...` 整行染色。"""
    m = LEVEL_KEYWORD_RE.search(line)
    if m is None:
        return None
    color, bold = _level_style(m.group(1))
    return ColoredSegment(line, color, None, bold)


# 键值对 VALUE 强调色（暗底适配，见 COLOR-T07 Palette）
KV_COLOR = "cyan"
NUM_COLOR = "magenta"


def kv_rule(line: str) -> list[ColoredSegment] | None:
    """键值对规则（COLOR-T04）：`KEY: VALUE` 的 VALUE 用强调色，KEY 默认色。"""
    segs: list[ColoredSegment] = []
    pos = 0
    for m in KV_RE.finditer(line):
        if m.start() > pos:
            segs.append(ColoredSegment(line[pos : m.start()], None))
        segs.append(ColoredSegment(m.group(1), None))  # KEY 默认色
        segs.append(ColoredSegment(m.group(2), KV_COLOR))  # VALUE 强调色
        pos = m.end()
    if not segs:
        return None
    if pos < len(line):
        segs.append(ColoredSegment(line[pos:], None))
    return segs


def number_rule(line: str) -> list[ColoredSegment] | None:
    """数值规则（COLOR-T04）：`0x..` / 浮点 / 整数 用强调色。"""
    segs: list[ColoredSegment] = []
    pos = 0
    for m in NUM_RE.finditer(line):
        if m.start() > pos:
            segs.append(ColoredSegment(line[pos : m.start()], None))
        segs.append(ColoredSegment(m.group(1), NUM_COLOR))
        pos = m.end()
    if not segs:
        return None
    if pos < len(line):
        segs.append(ColoredSegment(line[pos:], None))
    return segs


# 内置规则清单：(名称, 优先级, 函数)。优先级即规则链顺序（SPEC §2.1）。
BUILTIN_RULES: tuple[tuple[str, int, BuiltinFunc], ...] = (
    ("bracket", 1, bracket_rule),
    ("keyword", 2, keyword_rule),
    ("kv", 3, kv_rule),
    ("number", 4, number_rule),
)
