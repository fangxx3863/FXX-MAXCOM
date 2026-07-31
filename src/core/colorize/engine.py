"""自动染色规则链执行引擎（COLOR-T01/T06）。

按优先级对一行日志首次匹配生效，产出带颜色标签的段（不写回日志行，只附加颜色）。
- 总开关 master_enabled 关闭 → 全部默认色（INV-2）。
- ANSI 让位 ansi_yield：数据含 ANSI 序列时不插手（INV-1），由 ansi 模块负责解析。
- 优先级稳定排序：priority 越小越先；同优先级按注册顺序（内置: level=1 keyword=2 kv=3 number=4）。

用户规则 priority 缺省时取 3.5（排在 kv=3 之后、number=4 之前），保证默认用户规则
在广义数值规则吞噬整行之前仍有机会命中。规则名是独立开关（enable_rule）的键。
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass

from app.models.color_rule import ColorRule

logger = logging.getLogger(__name__)

# 用户规则缺省优先级：kv(3) 与 number(4) 之间
_DEFAULT_USER_PRIORITY = 3.5

ANSI_RE = re.compile(r"\x1b\[")


def contains_ansi(line: str) -> bool:
    """数据行是否含 ANSI CSI 序列（用于让位检测）。"""
    return ANSI_RE.search(line) is not None


@dataclass
class ColoredSegment:
    """染色段：文本 + 颜色标签（颜色名为字符串，渲染层经 Palette 解析为 RGB）。"""

    text: str
    fg: str | None
    bg: str | None = None
    bold: bool = False


# 内置规则函数签名：单段 / 多段 / 无匹配（None 或空列表）
BuiltinFunc = Callable[[str], ColoredSegment | list[ColoredSegment] | None]


class _BaseRule:
    """规则抽象基类。process 返回染色段；None/空 = 未命中。"""

    name: str
    priority: int | float
    enabled: bool = True

    def process(self, line: str) -> list[ColoredSegment] | None:  # pragma: no cover
        raise NotImplementedError


class _UserRule(_BaseRule):
    """用户 ColorRule 包装：编译正则，按 target 染色。"""

    def __init__(self, rule: ColorRule) -> None:
        self.rule = rule
        self.name = rule.name
        self.priority = rule.priority if rule.priority is not None else _DEFAULT_USER_PRIORITY
        try:
            self._pattern: re.Pattern[str] | None = re.compile(rule.pattern)
        except re.error:
            logger.warning("colorize: 规则 %r 正则非法，已跳过", rule.name)
            self._pattern = None

    @property
    def enabled(self) -> bool:
        return self.rule.enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self.rule.enabled = value

    def process(self, line: str) -> list[ColoredSegment] | None:
        if self._pattern is None:
            return None
        if self.rule.target == "line":
            m = self._pattern.search(line)
            if m is None:
                return None
            return [ColoredSegment(line, self.rule.color, self.rule.bg_color, self.rule.bold)]
        segs: list[ColoredSegment] = []
        pos = 0
        for m in self._pattern.finditer(line):
            if m.start() > pos:
                segs.append(ColoredSegment(line[pos : m.start()], None))
            segs.append(
                ColoredSegment(m.group(), self.rule.color, self.rule.bg_color, self.rule.bold)
            )
            pos = m.end()
        if not segs:
            return None
        if pos < len(line):
            segs.append(ColoredSegment(line[pos:], None))
        return segs


class _BuiltinRule(_BaseRule):
    """内置规则包装（等级括号/关键词/键值对/数值）。"""

    def __init__(self, name: str, priority: int, func: BuiltinFunc) -> None:
        self.name = name
        self.priority = priority
        self._func = func

    def process(self, line: str) -> list[ColoredSegment] | None:
        result = self._func(line)
        if result is None:
            return None
        if isinstance(result, ColoredSegment):
            return [result]
        return result or None


class ColorizeEngine:
    """规则链执行引擎。"""

    def __init__(self, with_builtins: bool = True) -> None:
        self.master_enabled = True
        self.ansi_yield = True
        self._rules: list[_BaseRule] = []
        if with_builtins:
            from core.colorize.builtin_rules import BUILTIN_RULES

            for name, priority, func in BUILTIN_RULES:
                self.register_builtin(name, priority, func)

    def register(self, rule: ColorRule) -> None:
        """注册用户规则（COLOR-T01/T05）。"""
        self._rules.append(_UserRule(rule))

    def register_builtin(self, name: str, priority: int, func: BuiltinFunc) -> None:
        self._rules.append(_BuiltinRule(name, priority, func))

    def enable_rule(self, name: str, enabled: bool) -> None:
        """按规则名独立开关（INV-2）。"""
        for rule in self._rules:
            if rule.name == name:
                rule.enabled = enabled

    def reset(self) -> None:
        """清空全部规则（含内置）。"""
        self._rules.clear()

    def process_line(self, line: str) -> list[ColoredSegment]:
        """对一行应用规则链，返回染色段。"""
        if not self.master_enabled:
            return [ColoredSegment(line, None)]
        if self.ansi_yield and contains_ansi(line):
            return [ColoredSegment(line, None)]
        ordered = sorted(enumerate(self._rules), key=lambda t: (t[1].priority, t[0]))
        for _, rule in ordered:
            if not rule.enabled:
                continue
            segs = rule.process(line)
            if segs is not None:
                return segs
        return [ColoredSegment(line, None)]
