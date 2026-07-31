"""击键直传映射（TERM-T02）。

键盘事件 → 串口字节。可打印字符直接编码；控制字符（Ctrl 组合）优先于字符；
方向键 → ESC 序列；Tab/Enter/Backspace 映射可配置。

映射可配置项与全局配置一致（ADR-0014：Enter 换行形式 / Backspace 码）。
"""

from __future__ import annotations

from dataclasses import dataclass

ENTER_LF = "lf"  # 0x0A
ENTER_CR = "cr"  # 0x0D
ENTER_CRLF = "crlf"  # 0x0D 0x0A

BACKSPACE_DEL = "del"  # 0x7F
BACKSPACE_BS = "bs"  # 0x08


@dataclass
class KeyMapConfig:
    enter: str = ENTER_CRLF
    backspace: str = BACKSPACE_DEL


def _ctrl(ch: str, shift: bool = False) -> int:
    # Ctrl+A..Z → 0x01..0x1A
    return ord(ch.upper()) - 0x40


# DPG 修饰键掩码（dearpygui.mvKey_ModCtrl/Shift/Alt = 0x1000/0x2000/0x4000）。
# 键盘处理器回调 app_data = 按键 key id；修饰键用 dpg.is_key_down(mvKey_Mod*) 读取，
# 因此 on_key 把 modifiers 作为 0x1000/0x2000/0x4000 掩码接收（与 DPG mvKey_Mod* 对齐）。
MOD_CTRL = 0x1000
MOD_SHIFT = 0x2000
MOD_ALT = 0x4000

# DPG 特殊键 key id（实测 dearpygui 2.3.1）
KEY_LEFT = 0x201
KEY_RIGHT = 0x202
KEY_UP = 0x203
KEY_DOWN = 0x204
KEY_BACK = 0x20B
KEY_RETURN = 0x20D
KEY_TAB = 0x200
KEY_ESCAPE = 0x20E
KEY_SPACE = 0x20

_ARROW_SEQ = {
    KEY_UP: b"[A",
    KEY_DOWN: b"[B",
    KEY_RIGHT: b"[C",
    KEY_LEFT: b"[D",
}


def on_key(key: int, modifiers: int, cfg: KeyMapConfig) -> bytes:
    """返回要发送的字节；空 bytes 表示无发送。modifiers 与 DPG mvKey_Mod* 对齐。"""
    ctrl = bool(modifiers & MOD_CTRL)
    alt = bool(modifiers & MOD_ALT)
    shift = bool(modifiers & MOD_SHIFT)

    if ctrl:
        if 0x61 <= key <= 0x7A:  # Ctrl+a..z → 0x01..0x1A
            return bytes([_ctrl(chr(key))])
        if key in (KEY_RETURN, KEY_TAB):  # Ctrl+Return / Ctrl+Tab → LF / TAB
            return b"\x0a" if key == KEY_RETURN else b"\x09"
        if key == KEY_SPACE:  # Ctrl+Space → NUL
            return b"\x00"
        return b""

    if key == KEY_RETURN:  # Enter
        return _enter_bytes(cfg.enter)
    if key == KEY_TAB:  # Tab
        return b"\x09"
    if key == KEY_BACK:  # Backspace
        return _backspace_bytes(cfg.backspace)
    if key == KEY_ESCAPE:  # Esc
        return b"\x1b"

    if key in _ARROW_SEQ:  # 方向键 → ESC 序列
        return b"\x1b" + _ARROW_SEQ[key]

    if 0x20 <= key <= 0x7E:  # 可打印 ASCII
        ch = chr(key)
        if shift:
            ch = ch.upper() if ch.islower() else ch
        return ch.encode("utf-8")

    if alt:
        return b"\x1b" + chr(key).encode("utf-8")

    return b""


def _enter_bytes(mode: str) -> bytes:
    if mode == ENTER_LF:
        return b"\x0a"
    if mode == ENTER_CR:
        return b"\x0d"
    return b"\x0d\x0a"


def _backspace_bytes(mode: str) -> bytes:
    return b"\x7f" if mode == BACKSPACE_DEL else b"\x08"
