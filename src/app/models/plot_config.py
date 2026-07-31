"""绘图配置模型（contracts:plot-config.schema.json）。

data_format 是 discriminated union（type 字段分派），见 T0-T03 易错点。
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class SimpleBinaryFormat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["simple_binary"]
    channel_count: int = Field(ge=1)
    dtype: Literal[
        "int8",
        "uint8",
        "int16",
        "uint16",
        "int32",
        "uint32",
        "int64",
        "uint64",
        "float32",
        "float64",
    ]
    byte_order: Literal["little", "big"]


class AsciiDelimitedFormat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ascii_delimited"]
    delimiter: str
    filter_prefix: str | None = None
    channel_count: int = Field(ge=1)


class CustomFrameFormat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["custom_frame"]
    frame_header: str
    frame_tail: str | None = None
    frame_length: int | None = None
    dtype: Literal[
        "int8",
        "uint8",
        "int16",
        "uint16",
        "int32",
        "uint32",
        "int64",
        "uint64",
        "float32",
        "float64",
    ]
    byte_order: Literal["little", "big"]
    checksum: Literal["none", "checksum", "crc16"] = "none"
    channel_count: int = Field(ge=1)


DataFormat = Annotated[
    SimpleBinaryFormat | AsciiDelimitedFormat | CustomFrameFormat,
    Field(discriminator="type"),
]


class Channel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0)
    name: str
    color: str | None = None
    visible: bool = True


class PlotConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    data_format: DataFormat
    display: list[Literal["waveform", "bar", "fft", "scatter"]]
    channels: list[Channel] = Field(default_factory=list)
    buffer_points: int | None = None
    y_auto: bool = True
    y_min: float | None = None
    y_max: float | None = None
    fft_points: Literal[1024, 2048, 4096, 8192, 16384, 32768, 65536] | None = None
