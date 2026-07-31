"""CJK 字体注册（修复 DPG 默认字体无中文 → 渲染为 ???）。

DPG 默认字体（ProggyClean）只有 ASCII 字形。注册系统 CJK 字体并绑定为默认字体，
全部中文标签/文本才能正常显示。必须在 create_viewport 之前注册。

只注册字形范围，不改任何 widget 的字体参数（默认字体统一生效）。
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

import dearpygui.dearpygui as dpg

# Windows 系统字体候选（按优先级；本机 Windows 11 有微软雅黑）
FONT_CANDIDATES: tuple[tuple[str, str], ...] = (
    ("C:/Windows/Fonts/msyh.ttc", "微软雅黑"),
    ("C:/Windows/Fonts/Deng.ttf", "等线"),
    ("C:/Windows/Fonts/simhei.ttf", "黑体"),
    ("C:/Windows/Fonts/simsun.ttc", "宋体"),
)


def find_cjk_font() -> str | None:
    """返回第一个存在的 CJK 字体路径；找不到返回 None。"""
    for path, _ in FONT_CANDIDATES:
        if Path(path).exists():
            return path
    return None


def register_fonts(base_size: int = 18) -> int | None:
    """注册 CJK 默认字体并绑定，返回字体 tag。

    无可用字体时返回 None（沿用 DPG 默认字体，中文仍为 ???，仅记录日志）。
    DPG 规则：add_font 必须在 create_viewport 之前；bind_font 作用于全局默认字体。
    """
    font_path = find_cjk_font()
    if font_path is None:
        return None
    with dpg.font_registry():
        with dpg.font(font_path, base_size) as font_tag:
            # 该 DPG 版本字符范围自动覆盖（add_font_range* 已废弃为 no-op），无需手动加范围
            pass
    tag = cast(int, font_tag)
    dpg.bind_font(tag)
    return tag
