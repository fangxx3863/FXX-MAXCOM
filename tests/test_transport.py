"""传输层测试（TP-T01/T02）。"""

from __future__ import annotations

import pytest

from core.transport import (
    SerialConfig,
    SerialTransport,
    TransportBase,
    TransportType,
    discover_serial_ports,
)


def test_transport_type_enum() -> None:
    assert TransportType.SERIAL.value == "serial"
    assert TransportType.TCP_CLIENT.value == "tcp_client"


def test_serial_config_defaults() -> None:
    cfg = SerialConfig()
    assert cfg.transport_type == TransportType.SERIAL
    assert cfg.baudrate == 115200
    assert cfg.data_bits == 8
    assert cfg.parity == "none"


def test_serial_config_validate_missing_port() -> None:
    cfg = SerialConfig()
    with pytest.raises(ValueError):
        cfg.validate()


def test_serial_config_validate_bad_baud() -> None:
    cfg = SerialConfig()
    cfg.port = "COM3"
    cfg.baudrate = 100
    with pytest.raises(ValueError):
        cfg.validate()


def test_serial_config_validate_bad_parity() -> None:
    cfg = SerialConfig()
    cfg.port = "COM3"
    cfg.parity = "weird"
    with pytest.raises(ValueError):
        cfg.validate()


def test_serial_config_validate_ok() -> None:
    cfg = SerialConfig()
    cfg.port = "COM3"
    cfg.baudrate = 115200
    cfg.validate()  # 不抛异常


def test_serial_transport_implements_base() -> None:
    t = SerialTransport()
    assert isinstance(t, TransportBase)
    assert t.transport_type == TransportType.SERIAL
    assert not t.is_open()
    assert t.read() == b""
    assert t.write(b"x") == 0
    assert t.get_config() is None


def test_serial_transport_open_wrong_config_type() -> None:
    from core.transport.base import TransportConfig

    t = SerialTransport()
    with pytest.raises(TypeError):
        t.open(TransportConfig(TransportType.SERIAL))


def test_serial_transport_open_missing_port_raises() -> None:
    t = SerialTransport()
    cfg = SerialConfig()
    with pytest.raises(ValueError):
        t.open(cfg)


def test_discover_returns_list() -> None:
    # 无真实串口时返回空列表，绝不抛异常
    ports = discover_serial_ports()
    assert isinstance(ports, list)
    for p in ports:
        assert p.device
        assert isinstance(p.label(), str)
