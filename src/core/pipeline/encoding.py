"""编码检测与转换（V2 §1.10）。

UTF-8 / GBK / GB2312 / Latin-1 自动检测。decode 用 errors="replace"，绝不抛异常。
检测是启发式，不保证 100%——UI 需提供手动覆盖入口。
"""

from __future__ import annotations

from itertools import pairwise

UTF8_BOM = b"\xef\xbb\xbf"

# 所有合法编码名（对应 global-config default_encoding 枚举 + "auto"）
SUPPORTED_ENCODINGS = frozenset({"utf-8", "gbk", "gb2312", "latin-1"})
AUTO = "auto"


class EncodingDetector:
    """无状态编码检测器；每份数据独立检测，不做跨帧有状态解码。"""

    def detect(self, data: bytes) -> str:
        """返回 "utf-8" / "gbk" / "gb2312" / "latin-1" / "auto"（无法判定）。"""
        if data.startswith(UTF8_BOM):
            return "utf-8"
        if not data:
            return "auto"
        try:
            data.decode("utf-8")
            return "utf-8"
        except UnicodeDecodeError:
            pass
        # GBK 特征：存在相邻两字节均落在 GBK 双字节首/次字节范围（0x81-0xFE）。
        for a, b in pairwise(data):
            if 0x81 <= a <= 0xFE and 0x81 <= b <= 0xFE:
                return "gbk"
        return "auto"

    def decode(self, data: bytes, encoding: str) -> str:
        """按指定编码解码；encoding 为 "auto" 时先自动检测。绝不抛异常。"""
        enc = self.detect(data) if encoding == AUTO else encoding
        if enc == AUTO:
            # 无法判定时退化为 latin-1（对任意字节都可解码，保显示）。
            enc = "latin-1"
        return data.decode(enc, errors="replace")
