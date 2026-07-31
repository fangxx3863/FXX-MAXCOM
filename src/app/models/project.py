"""Project 元数据模型（contracts:project-file.schema.json）。

仅实现 project 段 + tags（契约当前只定义这两部分）。
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ProjectMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    name: str
    created: datetime | None = None
    modified: datetime | None = None
    description: str | None = None


class ProjectFile(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    project: ProjectMeta
    # 契约中该键含点号，pydantic 字段别名映射：project.tags → tags
    tags: dict[str, str] | None = Field(default=None, alias="project.tags")
