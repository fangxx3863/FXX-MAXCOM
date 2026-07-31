"""串口传输实现 + 发现枚举（TP-T02）。

pyserial 封装。发现枚举：list_ports.comports() → (端口名, 描述)。
配置字段对齐 transport.schema.json（contracts 冻结，R1）。
"""

from __future__ import annotations

from dataclasses import dataclass

import serial
from serial.tools import list_ports

from core.transport.base import TransportBase, TransportConfig, TransportType

# 允许的串口参数（对齐 transport.schema.json）
_DATA_BITS = (5, 6, 7, 8)
_PARITY_MAP = {
    "none": serial.PARITY_NONE,
    "even": serial.PARITY_EVEN,
    "odd": serial.PARITY_ODD,
    "mark": serial.PARITY_MARK,
    "space": serial.PARITY_SPACE,
}
_STOP_BITS_MAP = {
    1: serial.STOPBITS_ONE,
    1.5: serial.STOPBITS_ONE_POINT_FIVE,
    2: serial.STOPBITS_TWO,
}


@dataclass
class SerialPortInfo:
    """发现的串口：端口名 + 描述（P4 端口页枚举用）。"""

    device: str
    description: str

    def label(self) -> str:
        return f"{self.device} | {self.description}" if self.description else self.device


class SerialConfig(TransportConfig):
    """串口连接配置（字段对齐 transport.schema.json）。"""

    def __init__(self) -> None:
        super().__init__(TransportType.SERIAL)
        self.port = ""
        self.baudrate = 115200
        self.data_bits = 8
        self.stop_bits = 1
        self.parity = "none"
        self.flow_control = "none"
        self.timeout_s = 0.05

    def validate(self) -> None:
        """参数校验：非法值抛 ValueError（UI 层在连接前调用）。"""
        if not self.port:
            raise ValueError("串口未选择")
        if self.baudrate < 300:
            raise ValueError(f"非法波特率: {self.baudrate}")
        if self.data_bits not in _DATA_BITS:
            raise ValueError(f"非法数据位: {self.data_bits}")
        if self.parity not in _PARITY_MAP:
            raise ValueError(f"非法校验位: {self.parity}")
        if self.stop_bits not in _STOP_BITS_MAP:
            raise ValueError(f"非法停止位: {self.stop_bits}")
        if self.flow_control not in ("none", "software", "hardware"):
            raise ValueError(f"非法流控: {self.flow_control}")


def discover_serial_ports() -> list[SerialPortInfo]:
    """枚举当前系统串口。无 pyserial/无端口时返回空列表，绝不抛异常。"""
    try:
        return [
            SerialPortInfo(device=p.device, description=p.description or "")
            for p in list_ports.comports()
        ]
    except Exception:
        return []


class SerialTransport(TransportBase):
    """串口传输实现（pyserial）。阻塞读 + 统一 write（INV-2）。"""

    def __init__(self) -> None:
        self._ser: serial.Serial | None = None
        self._config: SerialConfig | None = None

    @property
    def transport_type(self) -> TransportType:
        return TransportType.SERIAL

    def open(self, config: TransportConfig) -> None:
        if not isinstance(config, SerialConfig):
            raise TypeError(f"SerialTransport 需要 SerialConfig，收到 {type(config).__name__}")
        config.validate()
        if self._ser is not None and self._ser.is_open:
            self.close()
        self._ser = serial.Serial(
            port=config.port,
            baudrate=config.baudrate,
            bytesize=config.data_bits,
            parity=_PARITY_MAP[config.parity],
            stopbits=_STOP_BITS_MAP[config.stop_bits],
            timeout=config.timeout_s,
        )
        self._config = config

    def close(self) -> None:
        if self._ser is not None:
            try:
                self._ser.close()
            finally:
                self._ser = None
                self._config = None

    def is_open(self) -> bool:
        return self._ser is not None and self._ser.is_open

    def read(self, size: int = 4096) -> bytes:
        if self._ser is None:
            return b""
        data: bytes = self._ser.read(size)
        return data

    def write(self, data: bytes) -> int:
        if self._ser is None or not self._ser.is_open:
            return 0
        written: int = self._ser.write(data)
        return written

    def get_config(self) -> SerialConfig | None:
        return self._config
