"""过滤引擎模块（FLT）。

日志行过滤（显示/隐藏），正则规则链，在染色之后执行（颜色标签不受影响）。
只做显示判定，不改原始流（INV-3）。
"""

from core.filter.engine import FilterEngine
from core.filter.loader import load_rules

__all__ = [
    "FilterEngine",
    "load_rules",
]
