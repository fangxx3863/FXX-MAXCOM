"""全局配置管理（ADR-0003）。

全局配置存 %APPDATA%/MAXCOM/config.toml，只放与项目无关的个人偏好
（主题/语言/字体/端口黑名单/别名/记忆）。项目相关配置进 .maxcomprj。
"""

from __future__ import annotations

import logging
import os
import tomllib
from pathlib import Path

import tomli_w

from app.models.global_config import GlobalConfig

logger = logging.getLogger(__name__)


class ConfigManager:
    """全局配置读写。load 失败回退默认并记日志，绝不崩溃。"""

    def __init__(self, path: Path) -> None:
        self._path = path

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> GlobalConfig:
        if not self._path.exists():
            logger.info("config: %s missing, using defaults", self._path)
            return GlobalConfig()
        try:
            raw = tomllib.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError) as exc:
            logger.warning("config: failed to read %s (%s), using defaults", self._path, exc)
            return GlobalConfig()
        try:
            return GlobalConfig.model_validate(raw)
        except Exception as exc:  # pydantic ValidationError 等 → 回退默认
            logger.warning("config: validation failed for %s (%s), using defaults", self._path, exc)
            return GlobalConfig()

    def save(self, cfg: GlobalConfig) -> None:
        """原子写：先写临时文件再 rename，避免写坏配置。"""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(tomli_w.dumps(cfg.model_dump(exclude_none=True)), encoding="utf-8")
        tmp.replace(self._path)


def default_config_dir() -> Path:
    """%APPDATA%/MAXCOM（Windows）。其他平台回退 ~/.config/maxcom。"""
    base = os.environ.get("APPDATA")
    if base:
        return Path(base) / "MAXCOM"
    return Path.home() / ".config" / "maxcom"
