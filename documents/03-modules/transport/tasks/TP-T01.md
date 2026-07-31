# TP-T01: TransportBase 抽象 + TransportConfig

> 模块：transport ｜ 依赖：T0-T03

## 目标
实现 TransportBase 抽象接口与 TransportConfig（contracts:transport.schema.json 的 pydantic 模型）。

## IMPL `[详细]`

### 签名
```python
class TransportType(Enum):
    SERIAL = "serial"; TCP_CLIENT = "tcp_client"; TCP_SERVER = "tcp_server"
    UDP_CLIENT = "udp_client"; UDP_SERVER = "udp_server"; WINUSB = "winusb"; HID = "hid"

class TransportConfig(BaseModel):      # 来自 contracts
    type: TransportType
    port: str = ""; alias: str = ""; baudrate: int = 115200
    data_bits: int = 8; stop_bits: int = 1; parity: str = "none"
    flow_control: str = "none"
    host: str = ""; port_no: int = 0
    auto_reconnect: AutoReconnect | None = None

class TransportBase(ABC):
    @property @abstractmethod transport_type: TransportType
    @abstractmethod open(config) -> None
    @abstractmethod close() -> None
    @abstractmethod is_open() -> bool
    @abstractmethod read(size=4096) -> bytes
    @abstractmethod write(data) -> int
    @abstractmethod get_config() -> TransportConfig
    @abstractmethod set_dtr_rts(dtr, rts) -> None
    on_data: Callable[[bytes], None] | None = None
    on_disconnect: Callable[[], None] | None = None
    on_error: Callable[[Exception], None] | None = None
```

### 完成标准（DoD）
- [ ] 抽象接口就位，可被各实现继承
- [ ] TransportConfig 可 pydantic 校验
- [ ] mypy strict 通过

## 禁止事项
- 抽象不依赖具体传输库（pyserial 等）
