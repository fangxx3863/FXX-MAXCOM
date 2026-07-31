# PLT-T02: Simple Binary 解析器

> 模块：plot ｜ 依赖：PLT-T01, T0-T03

## 目标
实现 Simple Binary 帧解析：通道数 + 数据类型（int8~float64）+ 端序。

## IMPL `[详细]`

### 签名
```python
class SimpleBinaryParser:
    def __init__(self, channel_count: int, dtype: str, byte_order: str): ...
    def feed(self, data: bytes) -> list[list[float]]:
        # 返回一批采样，每通道一个 float 列表
    @property
    def bytes_per_sample(self) -> int:
        # dtype 字节数 × channel_count
```

### 伪代码
```
feed(data):
    self._buf += data
    samples_per_row = channel_count
    rows = []
    while len(self._buf) >= bytes_per_sample:
        row = struct.unpack_from(fmt, self._buf, 0)   # fmt = f"{byte_order}{channel_count}{typechar}"
        rows.append(list(row))
        self._buf = self._buf[bytes_per_sample:]
    return rows
```

### 易错点
- dtype → struct 格式映射：int8=`b` uint8=`B` int16=`h` uint16=`H` int32=`i` uint32=`I` int64=`q` uint64=`Q` float32=`f` float64=`d`。
- 端序：little=`<` big=`>`。
- 剩余不足一行的字节留在 buf，下次续接。

### 完成标准（DoD）
- [ ] 每种 dtype + 两种端序解析正确
- [ ] 残余字节续接
- [ ] 采样值精确（对已知字节流断言）

## 禁止事项
- 解析器无 GUI 依赖，纯函数式
