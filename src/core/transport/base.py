"""传输层抽象与配置（TP-T01）。

TransportBase 定义统一 I/O 接口；实现（serial/TCP/UDP）在子模块。
单连接 + 多实例（ADR-0016）：多个 Transport 实例可共存，各自独立连接。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import StrEnum


class TransportType(StrEnum):
    SERIAL = "serial"
    TCP_CLIENT = "tcp_client"
    TCP_SERVER = "tcp_server"
    UDP_CLIENT = "udp_client"
    UDP_SERVER = "udp_server"
    WINUSB = "winusb"
    HID = "hid"


class TransportConfig:
    """连接配置基类（序列化字段由各实现子类定义）。"""

    def __init__(self, transport_type: TransportType) -> None:
        self.transport_type = transport_type

    def __repr__(self) -> str:  # pragma: no cover
        return f"{type(self).__name__}(type={self.transport_type.value})"


class TransportBase(ABC):
    """传输抽象：open/close/read/write + 生命周期回调（TP-T01）。"""

    @property
    @abstractmethod
    def transport_type(self) -> TransportType: ...

    @abstractmethod
    def open(self, config: TransportConfig) -> None: ...

    @abstractmethod
    def close(self) -> None: ...

    @abstractmethod
    def is_open(self) -> bool: ...

    @abstractmethod
    def read(self, size: int = 4096) -> bytes: ...

    @abstractmethod
    def write(self, data: bytes) -> int: ...

    @abstractmethod
    def get_config(self) -> TransportConfig | None: ...

    # 生命周期回调（M3 连接管理器订阅）
    def on_data(self, data: bytes) -> None:  # noqa: B027 (空回调：可选覆盖)
        ...

    def on_disconnect(self) -> None:  # noqa: B027
        ...

    def on_error(self, exc: Exception) -> None:  # noqa: B027
        ...
