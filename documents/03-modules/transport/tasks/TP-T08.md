# TP-T08: 发送统一路径

> 模块：transport ｜ 依赖：TP-T01

## 目标
实现统一发送路径：终端击键、发送框、定时发送共用同一 `write` 入口，含换行符配置（ADR-0014）。

## IMPL `[详细]`

### 签名
```python
class SendPath:
    def __init__(self, transport: TransportBase): ...
    def set_newline(self, nl: Literal["none", "crlf", "lf", "cr"]) -> None: ...
    def send_text(self, text: str, encoding: str) -> int:
        # 编码 + 追加换行符 → write
    def send_hex(self, hex_str: str) -> int:
        # "A1 B2" / "A1B2" 解析 → write；非法 hex 报错
    def send_bytes(self, data: bytes) -> int: ...
```

### 易错点
- 换行符只在发送端追加（ADR-0014）；接收端解析是日志引擎职责。
- Hex 输入解析容错（空格分隔/连续），非法字符拒绝。
- 编码转换失败不崩溃（记录日志 + 提示）。

### 完成标准（DoD）
- [ ] 文本/Hex/字节三种发送
- [ ] 换行符追加正确（none/crlf/lf/cr）
- [ ] 非法 Hex 报错不崩溃

## 禁止事项
- 发送路径不接收（收发分离，各自独立）
