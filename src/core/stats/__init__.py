"""统计模块：字节计数 + 速率 + 错误帧。"""

from __future__ import annotations

from core.stats.tracker import RATE_WINDOW_S, StatsTracker

__all__ = ["RATE_WINDOW_S", "StatsTracker"]
