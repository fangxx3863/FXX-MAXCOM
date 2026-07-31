"""颜色调色板（COLOR-T07）。

把内置规则的颜色名 / hex 映射为具体 RGB，暗色主题适配（暗底亮字、亮底深字）。
纯数据，不依赖 DPG 特定 API；渲染层负责转 DPG 格式。

命名色由 sgr.BASIC_COLORS 提供（与 ANSI 16 色一致），等级色映射见 level_color。
未知颜色名回退主题默认前景。hex 格式 `#RRGGBB`。
"""

from __future__ import annotations

from core.ansi.sgr import BASIC_COLORS

# 命名色 → BASIC_COLORS 索引。colorize 层用名字做标签（不侵入 SGR 索引），渲染层解析。
NAMED: dict[str, int] = {
    "black": 0,
    "red": 1,
    "green": 2,
    "yellow": 3,
    "blue": 4,
    "magenta": 5,
    "cyan": 6,
    "white": 7,
    "gray": 8,
    "bright_red": 9,
    "bright_green": 10,
    "bright_yellow": 11,
    "bright_blue": 12,
    "bright_magenta": 13,
    "bright_cyan": 14,
    "bright_white": 15,
}


def _parse_hex(color: str) -> tuple[int, int, int] | None:
    """`#RRGGBB` / `RRGGBB` → RGB；非法返回 None。"""
    h = color.lstrip("#")
    if len(h) != 6:
        return None
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return None
    return (r, g, b)


class Palette:
    """命名色/hex → RGB；暗/亮主题等级色适配；未知回退默认。"""

    def __init__(self, theme: str = "dark") -> None:
        self.theme = theme

    def resolve(self, color: str | None) -> tuple[int, int, int]:
        """颜色名/hex → RGB。None 或未知回退主题默认前景。"""
        if color is None:
            return self.default_fg()
        rgb = _parse_hex(color)  # `#RRGGBB` / 无前缀 `RRGGBB`
        if rgb is not None:
            return rgb
        idx = NAMED.get(color)
        if idx is not None:
            return BASIC_COLORS[idx]
        return self.default_fg()

    def level_color(self, level: str) -> tuple[int, int, int]:
        """等级色：暗底亮字、亮底深字。未知等级回退默认前景。"""
        upper = level.upper()
        if upper in ("E", "ERROR", "ERR", "F", "FATAL", "CRITICAL"):
            return BASIC_COLORS[9] if self.theme == "dark" else BASIC_COLORS[1]
        if upper in ("W", "WARN", "WARNING"):
            return BASIC_COLORS[11] if self.theme == "dark" else BASIC_COLORS[3]
        if upper in ("D", "DEBUG"):
            return BASIC_COLORS[8]
        if upper in ("I", "INFO"):
            return self.default_fg()
        return self.default_fg()

    def default_fg(self) -> tuple[int, int, int]:
        return (220, 220, 224) if self.theme == "dark" else (32, 32, 32)
