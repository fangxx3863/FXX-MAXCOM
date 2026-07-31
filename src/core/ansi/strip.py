"""ANSI 序列剥离（日志路径清理）。

日志引擎收到的字节可能含 ANSI 控制序列（与终端模式共享同一原始流，ADR-0015）。
日志路径不做 ANSI 渲染（那是终端 viewport 的职责），但控制码不应直接打印。
strip_ansi 剥离全部 ESC 序列，保留可打印字符——让位（INV-1）的落地实现。
"""

from __future__ import annotations


def strip_ansi(text: str) -> str:
    """剥离 ANSI 控制序列，返回纯可打印文本。

    覆盖：CSI（\\x1b[...终值字节）、OSC（\\x1b]...BEL/ST）、两字符 ESC 序列、
    裸 ESC 单字符。未知/残缺序列按最安全方式吞掉 ESC 及其内容直到可打印边界。
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c != "\x1b":
            out.append(c)
            i += 1
            continue
        if i + 1 >= n:
            break  # 行尾裸 ESC，丢弃
        nxt = text[i + 1]
        if nxt == "[":
            # CSI: 跳过参数，直到 final 字节（0x40..0x7E）；残缺则吞到行尾
            j = i + 2
            while j < n and not (0x40 <= ord(text[j]) <= 0x7E):
                j += 1
            i = j + 1 if j < n else j
        elif nxt == "]":
            # OSC: 直到 BEL(\\x07) 或 ST(ESC\\)；残缺则吞到行尾
            j = i + 2
            while j < n and text[j] not in ("\x07", "\x1b"):
                j += 1
            if j < n and text[j] == "\x1b":
                i = j + 2 if j + 1 < n and text[j + 1] == "\\" else j + 1
            else:
                i = j + 1 if j < n else j
        else:
            # 两字符 ESC 序列（ESC + 单字符，如 ESC c）或 ESC 后跟可打印
            i += 2
    return "".join(out)
