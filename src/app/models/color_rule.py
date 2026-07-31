"""自动染色用户自定义规则模型（contracts:color-rule.schema.json）。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class ColorRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    pattern: str
    target: Literal["line", "match"]
    color: str
    bg_color: str | None = None
    bold: bool = False
    enabled: bool = True
    priority: int | None = None
