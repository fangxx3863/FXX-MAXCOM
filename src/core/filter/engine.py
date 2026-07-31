"""日志行过滤引擎（FLT-T01）。

多规则链，判定一行是否显示：默认显示；hide 规则匹配则隐藏；show 规则用于白名单（强制显示）。
正则预编译；只做显示判定，不改原始流（INV-3，ADR-0015）。

判定语义：按注册顺序扫描，首个生效规则决定结果（hide 匹配 → 隐藏；show 匹配 → 显示）；
全部不匹配 → 默认显示。FLT-T01 DoD"首个判定生效"即此。
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass

from app.models.filter_rule import FilterRule

logger = logging.getLogger(__name__)


@dataclass
class _CompiledRule:
    """编译后的规则（用于独立开关热切换）。"""

    name: str
    action: str
    match: Callable[[str], bool] | None  # None = 正则编译失败，永不匹配
    enabled: bool = True


def _compile(pattern: str) -> Callable[[str], bool] | None:
    try:
        regex = re.compile(pattern)
    except re.error:
        logger.warning("filter: 规则正则 %r 非法", pattern)
        return None
    return lambda s: regex.search(s) is not None


class FilterEngine:
    """过滤规则链。"""

    def __init__(self) -> None:
        self._rules: list[_CompiledRule] = []

    def add_rule(self, rule: FilterRule) -> None:
        """添加规则（重复同名覆盖）。"""
        compiled = _compile(rule.pattern)
        for existing in self._rules:
            if existing.name == rule.name:
                existing.action = rule.action
                existing.match = compiled
                existing.enabled = rule.enabled
                return
        self._rules.append(_CompiledRule(rule.name, rule.action, compiled, rule.enabled))

    def set_enabled(self, name: str, enabled: bool) -> None:
        """按规则名独立开关（FLT-T02）。"""
        for rule in self._rules:
            if rule.name == name:
                rule.enabled = enabled

    def should_show(self, line: str) -> bool:
        """判定一行是否显示（默认显示；首个生效规则决定）。"""
        for rule in self._rules:
            if not rule.enabled or rule.match is None:
                continue
            if rule.action == "hide" and rule.match(line):
                return False
            if rule.action == "show" and rule.match(line):
                return True
        return True

    def reset(self) -> None:
        self._rules.clear()
