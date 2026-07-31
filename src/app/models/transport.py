"""传输/连接配置模型（contracts:transport.schema.json）。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

TransportType = Literal[
    "serial",
    "tcp_client",
    "tcp_server",
    "udp_client",
    "udp_server",
    "winusb",
    "hid",
]

STOP_BITS = frozenset({1.0, 1.5, 2.0})


class AutoReconnect(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    max_retries: int = Field(default=10, ge=0)
    interval_ms: int = Field(default=1000, ge=0)


class TransportConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: TransportType
    port: str | None = None
    alias: str | None = None
    baudrate: int | None = Field(default=None, ge=300)
    data_bits: Literal[5, 6, 7, 8] | None = None
    stop_bits: float | None = None
    parity: Literal["none", "even", "odd", "mark", "space"] | None = None
    flow_control: Literal["none", "software", "hardware"] | None = None
    host: str | None = None
    port_no: int | None = None
    auto_reconnect: AutoReconnect | None = None

    @field_validator("stop_bits")
    @classmethod
    def _check_stop_bits(cls, v: float | None) -> float | None:
        if v is not None and float(v) not in STOP_BITS:
            raise ValueError(f"stop_bits must be one of {sorted(STOP_BITS)}, got {v}")
        return v
