"""用户自定义染色规则加载（COLOR-T05）。

从 color_rules.toml 加载 ColorRule 数组，pydantic 校验；非法配置跳过并记录日志，不崩溃。
priority 可插到内置规则之前（引擎按 priority 稳定排序）；每条规则可独立开关。
"""

from __future__ import annotations

import logging
import tomllib
from pathlib import Path

from pydantic import ValidationError

from app.models.color_rule import ColorRule
from core.colorize.engine import ColorizeEngine

logger = logging.getLogger(__name__)


def load_rules(path: Path) -> list[ColorRule]:
    """读取 color_rules.toml（顶层 `[[rules]]`），pydantic 校验。

    文件不存在/无 rules 键 → 空列表。非法条目跳过并记录日志，其余正常加载。
    """
    if not path.exists():
        return []
    try:
        with path.open("rb") as f:
            data = tomllib.load(f)
    except tomllib.TOMLDecodeError as exc:
        logger.warning("colorize: %s TOML 解析失败: %s", path, exc)
        return []
    rules: list[ColorRule] = []
    for item in data.get("rules", []):
        try:
            rules.append(ColorRule.model_validate(item))
        except ValidationError as exc:
            logger.warning("colorize: %s 规则非法，已跳过: %s", path, exc)
    return rules


def register_user_rule(engine: ColorizeEngine, rule: ColorRule) -> None:
    """注册单条用户规则（便于逐条开关/热加载）。"""
    engine.register(rule)
