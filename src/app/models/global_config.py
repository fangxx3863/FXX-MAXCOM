"""全局配置模型（contracts:global-config.schema.json）。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PortMemoryEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    baudrate: int | None = None
    data_bits: int | None = None
    stop_bits: int | None = None
    parity: str | None = None


class GlobalConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    theme: Literal["dark", "light"] = "dark"
    language: Literal["zh_CN", "en_US"] = "zh_CN"
    font: str | None = None
    default_encoding: Literal["utf-8", "gbk", "gb2312", "latin-1", "auto"] = "auto"
    recent_projects: list[str] = Field(default_factory=list)
    port_blacklist: list[str] = Field(default_factory=list)
    port_alias: dict[str, str] = Field(default_factory=dict)
    port_memory: dict[str, PortMemoryEntry] = Field(default_factory=dict)
