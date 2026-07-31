"""pydantic 契约模型包（R6）。

字段与 documents/02-contracts/*.schema.json 完全一致（漂移由 tools/check-contract-drift.py 校验）。
"""

from app.models.color_rule import ColorRule
from app.models.command import Command, Repeat
from app.models.filter_rule import FilterRule
from app.models.global_config import GlobalConfig, PortMemoryEntry
from app.models.plot_config import (
    AsciiDelimitedFormat,
    Channel,
    CustomFrameFormat,
    DataFormat,
    PlotConfig,
    SimpleBinaryFormat,
)
from app.models.project import ProjectFile, ProjectMeta
from app.models.transport import AutoReconnect, TransportConfig

__all__ = [
    "AsciiDelimitedFormat",
    "AutoReconnect",
    "Channel",
    "ColorRule",
    "Command",
    "CustomFrameFormat",
    "DataFormat",
    "FilterRule",
    "GlobalConfig",
    "PlotConfig",
    "PortMemoryEntry",
    "ProjectFile",
    "ProjectMeta",
    "Repeat",
    "SimpleBinaryFormat",
    "TransportConfig",
]
