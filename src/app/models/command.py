"""命令条目模型（contracts:command.schema.json）。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Repeat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    count: int = Field(ge=1)
    interval_ms: int = Field(ge=0)


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    group: str = ""
    data: str
    format: Literal["text", "hex"] = "text"
    shortcut: str = ""
    repeat: Repeat | None = None
    expect: str = ""
    timeout_ms: int = Field(default=0, ge=0)
