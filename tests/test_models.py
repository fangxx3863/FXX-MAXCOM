"""契约模型测试：样例数据可校验（T0-T03 DoD）。"""

import pytest
from pydantic import ValidationError

from app.models import (
    AsciiDelimitedFormat,
    ColorRule,
    Command,
    CustomFrameFormat,
    FilterRule,
    GlobalConfig,
    PlotConfig,
    ProjectFile,
    SimpleBinaryFormat,
    TransportConfig,
)


class TestCommand:
    def test_valid(self) -> None:
        cmd = Command(
            name="读温度",
            group="传感器",
            data="01 03 00 00 00 01",
            format="hex",
            shortcut="Ctrl+1",
            repeat={"count": 3, "interval_ms": 500},
            expect="02 03",
            timeout_ms=1000,
        )
        assert cmd.name == "读温度"
        assert cmd.repeat is not None
        assert cmd.repeat.count == 3

    def test_minimal(self) -> None:
        cmd = Command(name="hello", data="hi", format="text")
        assert cmd.group == ""
        assert cmd.repeat is None

    def test_invalid_repeat_count(self) -> None:
        with pytest.raises(ValidationError):
            Command(name="x", data="y", format="text", repeat={"count": 0, "interval_ms": 1})

    def test_extra_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            Command(name="x", data="y", format="text", bogus=1)


class TestFilterRule:
    def test_valid(self) -> None:
        rule = FilterRule(name="INFO", pattern=r"^\d+ INFO", action="show")
        assert rule.enabled is True

    def test_hide_action(self) -> None:
        rule = FilterRule(name="debug", pattern="DEBUG", action="hide", enabled=False)
        assert rule.enabled is False


class TestColorRule:
    def test_valid(self) -> None:
        rule = ColorRule(
            name="error", pattern=r"\bERROR\b", target="match", color="#FF0000", bold=True
        )
        assert rule.bold is True

    def test_defaults(self) -> None:
        rule = ColorRule(name="warn", pattern="WARN", target="line", color="#FF9500")
        assert rule.priority is None
        assert rule.bg_color is None


class TestTransport:
    def test_serial(self) -> None:
        cfg = TransportConfig(type="serial", port="COM3", baudrate=115200, data_bits=8, stop_bits=1)
        assert cfg.baudrate == 115200

    def test_stop_bits_half(self) -> None:
        cfg = TransportConfig(type="serial", port="COM3", stop_bits=1.5)
        assert cfg.stop_bits == 1.5

    def test_invalid_stop_bits(self) -> None:
        with pytest.raises(ValidationError):
            TransportConfig(type="serial", port="COM3", stop_bits=1.25)

    def test_tcp(self) -> None:
        cfg = TransportConfig(
            type="tcp_client",
            host="127.0.0.1",
            port_no=8080,
            auto_reconnect={"enabled": True, "max_retries": 5, "interval_ms": 2000},
        )
        assert cfg.auto_reconnect is not None
        assert cfg.auto_reconnect.max_retries == 5

    def test_auto_reconnect_defaults(self) -> None:
        cfg = TransportConfig(
            type="tcp_client", host="h", port_no=1, auto_reconnect={"enabled": True}
        )
        assert cfg.auto_reconnect.max_retries == 10
        assert cfg.auto_reconnect.interval_ms == 1000


class TestPlotConfig:
    def test_simple_binary(self) -> None:
        cfg = PlotConfig(
            name="accel",
            data_format={
                "type": "simple_binary",
                "channel_count": 3,
                "dtype": "int16",
                "byte_order": "little",
            },
            display=["waveform", "fft"],
            channels=[{"index": 0, "name": "ax"}, {"index": 1, "name": "ay"}],
            y_auto=True,
            fft_points=4096,
        )
        assert isinstance(cfg.data_format, SimpleBinaryFormat)
        assert cfg.data_format.channel_count == 3
        assert cfg.display == ["waveform", "fft"]

    def test_ascii_delimited(self) -> None:
        cfg = PlotConfig(
            name="csv",
            data_format={"type": "ascii_delimited", "delimiter": ",", "channel_count": 2},
            display=["waveform"],
        )
        assert isinstance(cfg.data_format, AsciiDelimitedFormat)
        assert cfg.data_format.filter_prefix is None

    def test_custom_frame(self) -> None:
        cfg = PlotConfig(
            name="frame",
            data_format={
                "type": "custom_frame",
                "frame_header": "AA55",
                "dtype": "float32",
                "byte_order": "big",
                "checksum": "crc16",
                "channel_count": 4,
            },
            display=["waveform", "bar", "scatter"],
        )
        assert isinstance(cfg.data_format, CustomFrameFormat)
        assert cfg.data_format.checksum == "crc16"

    def test_unknown_discriminator(self) -> None:
        with pytest.raises(ValidationError):
            PlotConfig(
                name="bad",
                data_format={"type": "unknown", "channel_count": 1},
                display=["waveform"],
            )

    def test_invalid_fft_points(self) -> None:
        with pytest.raises(ValidationError):
            PlotConfig(
                name="bad",
                data_format={
                    "type": "simple_binary",
                    "channel_count": 1,
                    "dtype": "uint8",
                    "byte_order": "little",
                },
                display=["waveform"],
                fft_points=100,
            )


class TestProject:
    def test_valid(self) -> None:
        proj = ProjectFile.model_validate(
            {
                "project": {"version": 1, "name": "demo", "created": "2026-07-31T10:00:00"},
                "project.tags": {"board": "esp32", "firmware": "v1.2"},
            }
        )
        assert proj.project.name == "demo"
        assert proj.tags == {"board": "esp32", "firmware": "v1.2"}

    def test_bad_version(self) -> None:
        with pytest.raises(ValidationError):
            ProjectFile.model_validate({"project": {"version": 2, "name": "x"}})

    def test_roundtrip_serializes_dotted_key(self) -> None:
        proj = ProjectFile(project={"version": 1, "name": "x"}, tags={"k": "v"})
        dumped = proj.model_dump(by_alias=True)
        assert "project.tags" in dumped
        assert dumped["project.tags"] == {"k": "v"}


class TestGlobalConfig:
    def test_defaults(self) -> None:
        cfg = GlobalConfig()
        assert cfg.theme == "dark"
        assert cfg.language == "zh_CN"
        assert cfg.default_encoding == "auto"

    def test_port_memory(self) -> None:
        cfg = GlobalConfig.model_validate(
            {"port_memory": {"COM3": {"baudrate": 115200, "parity": "none"}}}
        )
        assert cfg.port_memory["COM3"].baudrate == 115200
