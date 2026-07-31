"""本地回显（TERM-T03）。

远端不回显时显示层模拟输入效果：可打印字符直接显示、退格清除、
回车换行。只影响显示，不重复发送（发送仍走击键直传）。
"""

from __future__ import annotations


class LocalEcho:
    """本地回显开关 + 输入→显示文本映射。"""

    def __init__(self, enabled: bool = False) -> None:
        self.enabled = enabled
        self._line: list[str] = []

    def set_enabled(self, value: bool) -> None:
        self.enabled = value
        if not value:
            self._line.clear()

    def on_input(self, ch: str) -> str:
        """输入字符 → 应显示到屏幕的文本。enabled 关闭时返回空串。"""
        if not self.enabled:
            return ""
        if ch == "\x7f" or ch == "\x08":  # Backspace
            if self._line:
                self._line.pop()
                return "\b \b"
            return ""
        if ch == "\r" or ch == "\n":  # Enter
            self._line.clear()
            return "\r\n"
        if ch == "\x1b":  # Esc
            return ""
        code = ord(ch)
        if code < 0x20:  # 其它控制字符（Ctrl 组合）不回显
            return ""
        self._line.append(ch)
        return ch
