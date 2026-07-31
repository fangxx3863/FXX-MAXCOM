# PLT-T04: 自定义帧解析器

> 模块：plot ｜ 依赖：PLT-T01, T0-T03

## 目标
实现自定义帧解析：帧头/帧尾/帧长 + 数据类型 + 端序 + 校验（Checksum/CRC）。

## IMPL `[详细]`

### 签名
```python
class CustomFrameParser:
    def __init__(self, cfg: CustomFrameFormat): ...
        # frame_header(frame_tail可选)/frame_length/dtype/byte_order/checksum/channel_count
    def feed(self, data: bytes) -> list[list[float]]: ...
    def skip_byte(self) -> None: ...   # 丢弃 buf 首字节（对齐，见 PLT-T05）
```

### 伪代码
```
feed(data):
    self._buf += data
    frames = []
    while True:
        idx = self._buf.find(header)
        if idx == -1: break
        self._buf = self._buf[idx:]           # 对齐到帧头
        if len(self._buf) < full_frame_len: break
        body = self._buf[header_len : header_len + data_len]
        if checksum and !verify(body, tail):   # 校验失败
            skip_byte(); continue              # 数据错位，进跳过逻辑
        frames.append(unpack(body))            # 同 PLT-T02 的 unpack
        self._buf = self._buf[full_frame_len:]
    return frames
```

### 易错点
- **帧头出现在数据内**：必须从帧头起解析，校验失败时回退跳过（借 PLT-T05）。
- 校验（Checksum 求和 / CRC16）与发送端校验（CMD 模块）逻辑可复用 `protocol/checksum`。
- 帧长固定 vs 变长（frame_length 字段）两种情况。

### 完成标准（DoD）
- [ ] 帧头定位 + 长度 + 校验正确解析
- [ ] 校验失败触发跳过对齐
- [ ] 残余/错位数据容错

## 禁止事项
- 解析器不修改原始流，只动本地 buf/游标（INV-2）
