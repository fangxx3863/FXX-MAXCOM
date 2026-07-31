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


def on_key(key: int, modifiers: int, cfg: KeyMapConfig) -> bytes:
    """返回要发送的字节；空 bytes 表示无发送。modifiers 与 DPG mvKeyMod_* 对齐。"""
    ctrl = bool(modifiers & 1)
    alt = bool(modifiers & 2)
    shift = bool(modifiers & 4)

    if ctrl:
        ch = chr(key)
        if 0x61 <= key <= 0x7A:  # Ctrl+a..z
            return bytes([_ctrl(ch)])
        # Ctrl+特殊键
        if key in (0x0D, 0x0A):  # Ctrl+Enter → LF
            return b"\x0a"
        if key == 0x20:  # Ctrl+Space → NUL
            return b"\x00"
        return b""

    if key == 0x0D or key == 0x0A:  # Enter
        return _enter_bytes(cfg.enter)
    if key == 0x09:  # Tab
        return b"\x09"
    if key in (0x7F, 0x08):  # Backspace
        return _backspace_bytes(cfg.backspace)
    if key == 0x1B:  # Esc
        return b"\x1b"

    # 方向键（DPG 用特殊 key 值，见 dpg.mvKey_* 方向键区域）
    if key in (0x112, 0x113, 0x114, 0x115):  # mvKey_Up/Down/Left/Right
        seq = {0x112: b"[A", 0x113: b"[B", 0x114: b"[D", 0x115: b"[C"}
        return b"\x1b" + seq[key]

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
