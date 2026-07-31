"""过滤规则加载（FLT-T02）。

从 filters.toml 加载 FilterRule 数组，pydantic 校验；非法配置跳过并记录日志，不崩溃。
规则变更实时生效：加载后替换进引擎即可（add_rule 同名覆盖，不重启）。
"""

from __future__ import annotations

import logging
import tomllib
from pathlib import Path

from pydantic import ValidationError

from app.models.filter_rule import FilterRule

logger = logging.getLogger(__name__)


def load_rules(path: Path) -> list[FilterRule]:
    """读取 filters.toml（顶层 `[[rules]]`），pydantic 校验。

    文件不存在/无 rules 键 → 空列表。非法条目跳过并记录日志，其余正常加载。
    """
    if not path.exists():
        return []
    try:
        with path.open("rb") as f:
            data = tomllib.load(f)
    except tomllib.TOMLDecodeError as exc:
        logger.warning("filter: %s TOML 解析失败: %s", path, exc)
        return []
    rules: list[FilterRule] = []
    for item in data.get("rules", []):
        try:
            rules.append(FilterRule.model_validate(item))
        except ValidationError as exc:
            logger.warning("filter: %s 规则非法，已跳过: %s", path, exc)
    return rules
