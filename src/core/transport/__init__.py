"""传输层：抽象 + 串口实现 + 发现枚举（TP-T01/T02）。

M3 接入 TCP/UDP 实现；当前提供串口基础能力供端口页与收发/终端页连接。
"""

from __future__ import annotations

from core.transport.base import TransportBase, TransportConfig, TransportType
from core.transport.serial_transport import (
    SerialConfig,
    SerialPortInfo,
    SerialTransport,
    discover_serial_ports,
)

__all__ = [
    "SerialConfig",
    "SerialPortInfo",
    "SerialTransport",
    "TransportBase",
    "TransportConfig",
    "TransportType",
    "discover_serial_ports",
]
