# CMD-T03: 变量替换引擎

> 模块：command ｜ 依赖：CMD-T01

## 目标
实现变量替换：`{TIMESTAMP}` `{COUNTER}` `{HEX:xx}` 等在发送时求值。

## IMPL `[骨架]`

### 签名
```python
class VariableResolver:
    def __init__(self, counter_start: int = 1): ...
    def resolve(self, template: str) -> str: ...
        # 替换 {TIMESTAMP} {COUNTER} {HEX:xx}（xx=字节值 hex）等
```

### 完成标准（DoD）
- [ ] 时间戳/计数器/hex 变量替换
- [ ] 未知变量原样保留（或警告）
- [ ] 计数器自增

## 禁止事项
- 替换不改存储的命令（INV-2）
