"""日志过滤规则模型（contracts:filter-rule.schema.json）。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class FilterRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    pattern: str
    action: Literal["show", "hide"]
    enabled: bool = True
