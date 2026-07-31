# LOG-T05: 编码解码

> 模块：logview ｜ 依赖：LOG-T02, T0-T05

## 目标
把编码解码接入日志引擎：UTF-8/GBK/GB2312/Latin-1/自动检测（复用 T0-T05 EncodingDetector）。

## IMPL `[骨架]`

### 签名
```python
def decode_line(self, raw: bytes) -> str:
    # 用 encoding.detect 或用户指定编码解码，errors="replace"
```

### 完成标准（DoD）
- [ ] 手动编码解码正确
- [ ] 自动检测接入（BOM/启发式）
- [ ] 非法字节不崩溃（replacement 字符）

## 禁止事项
- 解码不阻塞；不跨帧有状态解码（每行独立）
