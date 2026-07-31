# CMD-T04: 自动校验（CRC/Checksum/XOR）

> 模块：command ｜ 依赖：T0-T03 ｜ 协议层核心

## 目标
实现 CRC8/CRC16/CRC32/Checksum/XOR 校验计算，自动追加到发送数据。与绘图自定义帧校验共用。

## IMPL `[详细]`

### 签名
```python
def checksum(data: bytes, algo: str) -> bytes:
    # algo: "crc8"|"crc16"|"crc32"|"checksum"|"xor"
    # 返回校验字节（低位在前按端序）

class ChecksumAppender:
    def __init__(self, algo: str, endian: str): ...
    def append(self, data: bytes) -> bytes: ...
```

### 完成标准（DoD）
- [ ] 每种算法计算正确（对已知向量断言）
- [ ] CRC 多项式/初始值/输出异或按标准（CRC16-MODBUS 等）
- [ ] 校验字节端序正确

## 禁止事项
- 校验算法单一实现，供 CMD 与 PLT 复用（勿各写一份）
