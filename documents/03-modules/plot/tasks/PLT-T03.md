# PLT-T03: ASCII 分隔解析器

> 模块：plot ｜ 依赖：PLT-T01

## 目标
实现 ASCII 分隔格式解析：分隔符 + 过滤前缀 + 通道数（SerialPlot 的 ASCII 模式）。

## IMPL `[详细]`

### 签名
```python
class AsciiDelimitedParser:
    def __init__(self, delimiter: str, filter_prefix: str, channel_count: int): ...
    def feed(self, data: bytes) -> list[list[float]]: ...
        # 按行拆分（\r\n），过滤前缀，按分隔符切分取数值
```

### 易错点
- 行内字段少于 channel_count → 丢弃该行（不误报）。
- 前缀过滤：以 filter_prefix 开头的行才解析。
- 解析失败的行跳过，不中断后续。

### 完成标准（DoD）
- [ ] 分隔符/前缀/通道数正确
- [ ] 字段不足行丢弃
- [ ] 非数值容忍（跳过该行）

## 禁止事项
- 不做十六进制 ASCII（那是 hex 视图）
