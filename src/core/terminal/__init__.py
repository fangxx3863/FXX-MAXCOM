"""交互式终端模块（TERM）。

纯逻辑（可 headless 单测）：击键映射 / 本地回显 / 选择 / 粘贴 / 回滚搜索。
GUI 渲染：ui.terminal_viewport.TerminalViewport（DPG）。
"""

from core.terminal.echo import LocalEcho
from core.terminal.keymap import KeyMapConfig, on_key
from core.terminal.paste import PasteManager
from core.terminal.search import ScrollbackSearch, search_in_cells
from core.terminal.selection import TextSelection

__all__ = [
    "KeyMapConfig",
    "LocalEcho",
    "PasteManager",
    "ScrollbackSearch",
    "TextSelection",
    "on_key",
    "search_in_cells",
]
