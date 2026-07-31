"""编码检测/转换测试（T0-T05 DoD）。"""

from core.pipeline.encoding import EncodingDetector

DET = EncodingDetector()


class TestDetect:
    def test_utf8_bom(self) -> None:
        assert DET.detect(b"\xef\xbb\xbfhello") == "utf-8"

    def test_utf8_chinese_no_bom(self) -> None:
        assert DET.detect("你好，串口".encode()) == "utf-8"

    def test_ascii_is_utf8(self) -> None:
        assert DET.detect(b"Hello World 123") == "utf-8"

    def test_gbk_chinese(self) -> None:
        assert DET.detect("串口调试工具".encode("gbk")) == "gbk"

    def test_gbk_adjacent_high_bytes(self) -> None:
        # 0xC4 0xE3 = GBK "你"，相邻两字节均在 0x81-0xFE 范围
        assert DET.detect(b"\xc4\xe3\xba\xc3") == "gbk"

    def test_single_latin_high_byte_auto(self) -> None:
        # 单个高位字节不足以构成 GBK 双字节特征 → auto
        assert DET.detect(b"\xe9") == "auto"

    def test_empty_auto(self) -> None:
        assert DET.detect(b"") == "auto"

    def test_pure_latin1_bytes(self) -> None:
        # latin-1 特有字节（非 GBK 双字节对、非 utf-8）
        assert DET.detect(b"caf\xe9") == "auto"


class TestDecode:
    def test_decode_utf8(self) -> None:
        assert DET.decode("你好".encode(), "utf-8") == "你好"

    def test_decode_gbk(self) -> None:
        assert DET.decode("串口".encode("gbk"), "gbk") == "串口"

    def test_decode_gb2312(self) -> None:
        assert DET.decode("串口".encode("gb2312"), "gb2312") == "串口"

    def test_decode_latin1(self) -> None:
        assert DET.decode(b"caf\xe9", "latin-1") == "café"

    def test_decode_invalid_bytes_no_raise(self) -> None:
        # 无效 utf-8 字节 → replacement 字符，绝不抛异常
        result = DET.decode(b"\xff\xfe\xfd", "utf-8")
        assert "�" in result

    def test_decode_auto_utf8(self) -> None:
        assert DET.decode("你好".encode(), "auto") == "你好"

    def test_decode_auto_gbk(self) -> None:
        assert DET.decode("串口".encode("gbk"), "auto") == "串口"

    def test_decode_auto_unrecognized_falls_back_latin1(self) -> None:
        # 无法判定时退化为 latin-1，任意字节可解码
        assert DET.decode(b"\xe9", "auto") == "é"

    def test_decode_empty(self) -> None:
        assert DET.decode(b"", "utf-8") == ""
