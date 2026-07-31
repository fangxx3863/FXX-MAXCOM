"""SGR 样式状态（ANS-T01）。

16色 / 256色 / 真彩色 / 粗体 / 斜体 / 下划线 / 删除线 / 反色。
apply_sgr 是纯函数：返回新状态，绝不修改入参（INV-4）。
反色（reverse）在渲染时才交换 fg/bg，此处只存原始值。
"""

from __future__ import annotations

from dataclasses import dataclass, replace

# ANSI 16 色（0-7 基本 / 8-15 亮色），索引即 ANSI 码位
BASIC_COLORS: tuple[tuple[int, int, int], ...] = (
    (0x00, 0x00, 0x00),
    (0xCC, 0x00, 0x00),
    (0x00, 0xCC, 0x00),
    (0xCC, 0xCC, 0x00),
    (0x00, 0x00, 0xCC),
    (0xCC, 0x00, 0xCC),
    (0x00, 0xCC, 0xCC),
    (0xCC, 0xCC, 0xCC),
    (0x66, 0x66, 0x66),
    (0xFF, 0x33, 0x33),
    (0x33, 0xFF, 0x33),
    (0xFF, 0xFF, 0x33),
    (0x33, 0x33, 0xFF),
    (0xFF, 0x33, 0xFF),
    (0x33, 0xFF, 0xFF),
    (0xFF, 0xFF, 0xFF),
)


def _cube_component(v: int) -> int:
    return 0 if v == 0 else 55 + v * 40


def xterm_256(idx: int) -> tuple[int, int, int]:
    """256 色索引 → RGB。

    0-15: 复用 16 色调色板；16-231: 6x6x6 立方体；232-255: 灰阶。
    """
    if idx < 16:
        return BASIC_COLORS[idx]
    if idx < 232:
        n = idx - 16
        r, g, b = n // 36, (n // 6) % 6, n % 6
        return (_cube_component(r), _cube_component(g), _cube_component(b))
    v = 8 + (idx - 232) * 10
    return (v, v, v)


@dataclass(frozen=True)
class SgrState:
    """当前图形属性。

    fg/bg 用 int 索引 BASIC_COLORS / 256 色，真彩色直接存 RGB tuple。
    用联合表示：int（调色板索引）或 tuple[3]（真彩）。
    """

    fg: int | tuple[int, int, int] | None = None
    bg: int | tuple[int, int, int] | None = None
    bold: bool = False
    italic: bool = False
    underline: bool = False
    strikethrough: bool = False
    reverse: bool = False

    @property
    def is_default(self) -> bool:
        return self == SgrState()

    def copy(self) -> SgrState:
        return replace(self)


def _color_param(params: list[int], i: int) -> tuple[int | tuple[int, int, int] | None, int]:
    """解析 38/48 变长子参数（`38;5;n` / `38;2;r;g;b`）。

    返回 (颜色, 新 i)；无法解析时返回 (None, i)。
    """
    if i + 1 >= len(params):
        return (None, i)
    kind = params[i + 1]
    if kind == 5 and i + 2 < len(params):
        return (params[i + 2], i + 2)
    if kind == 2 and i + 4 < len(params):
        r, g, b = params[i + 2], params[i + 3], params[i + 4]
        return ((r, g, b), i + 4)
    return (None, i)


def apply_sgr(state: SgrState, params: list[int]) -> SgrState:
    """应用 SGR 参数，返回新状态。未知值静默忽略。"""
    new = state.copy()
    i = 0
    while i < len(params):
        p = params[i]
        if p == 0:
            new = SgrState()
        elif p == 1:
            new = replace(new, bold=True)
        elif p == 2:
            new = replace(new, bold=False)
        elif p == 3:
            new = replace(new, italic=True)
        elif p == 4:
            new = replace(new, underline=True)
        elif p == 7:
            new = replace(new, reverse=True)
        elif p == 9:
            new = replace(new, strikethrough=True)
        elif p == 22:
            new = replace(new, bold=False)
        elif p == 23:
            new = replace(new, italic=False)
        elif p == 24:
            new = replace(new, underline=False)
        elif p == 27:
            new = replace(new, reverse=False)
        elif p == 29:
            new = replace(new, strikethrough=False)
        elif 30 <= p <= 37:
            new = replace(new, fg=p - 30)
        elif p == 38:
            color, i = _color_param(params, i)
            if color is not None:
                new = replace(new, fg=color)
        elif p == 39:
            new = replace(new, fg=None)
        elif 40 <= p <= 47:
            new = replace(new, bg=p - 40)
        elif p == 48:
            color, i = _color_param(params, i)
            if color is not None:
                new = replace(new, bg=color)
        elif p == 49:
            new = replace(new, bg=None)
        elif 90 <= p <= 97:
            new = replace(new, fg=p - 90 + 8)
        elif 100 <= p <= 107:
            new = replace(new, bg=p - 100 + 8)
        i += 1
    return new
