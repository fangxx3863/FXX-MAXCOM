# LOG-T06: 文件落盘 + 日志轮转

> 模块：logview ｜ 依赖：LOG-T03

## 目标
接收数据落盘：原始数据 + 时间戳，二进制/文本模式；日志轮转（按大小/时间切分）。

## IMPL `[骨架]`

### 签名
```python
class FileWriter:
    def __init__(self, path: Path, mode: Literal["binary","text"], rotate: RotateConfig): ...
    def write_frame(self, frame: TimedFrame) -> None: ...   # 原始 + 时间戳
    def maybe_rotate(self) -> None: ...                       # 按大小/时间切分
    def close(self) -> None: ...
```

### 完成标准（DoD）
- [ ] 二进制/文本模式落盘
- [ ] 时间戳一并写入
- [ ] 按大小/时间轮转
- [ ] 落盘在后台线程，不阻塞主链路

## 禁止事项
- 落盘是否含被过滤行见 O2（FLT-T03）
