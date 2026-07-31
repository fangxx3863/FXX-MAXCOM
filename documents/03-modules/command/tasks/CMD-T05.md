# CMD-T05: 命令链 + 发送历史

> 模块：command ｜ 依赖：CMD-T02

## 目标
实现命令链（多条按顺序/间隔发送）与发送历史（记录可复用）。

## IMPL `[骨架]`

### 签名
```python
class CommandChain:
    def __init__(self, send_path: SendPath): ...
    def run(self, commands: list[Command], interval_ms: int) -> None: ...
        # 依次发送，间隔 interval_ms；可中止

class SendHistory:
    def append(self, data: bytes, ts: int) -> None: ...
    def list(self, limit: int = 100) -> list[SendRecord]: ...
    def reuse(self, index: int) -> bytes: ...
```

### 完成标准（DoD）
- [ ] 命令链顺序 + 间隔发送
- [ ] 历史记录/复用

## 禁止事项
- 命令链不阻塞 GUI
