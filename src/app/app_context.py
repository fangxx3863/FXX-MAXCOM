"""应用级依赖注入容器。

T0 只承载 EventBus 与 ConfigManager；后续业务模块在此注册引擎实例。
"""

from __future__ import annotations

from app.config import ConfigManager
from core.pipeline.event_bus import EventBus


class AppContext:
    """MAXCOM 共享依赖容器（单实例）。"""

    def __init__(self) -> None:
        self.event_bus = EventBus()
        self.config: ConfigManager | None = None
