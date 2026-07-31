# CMD-T02: 命令执行 + 定时发送

> 模块：command ｜ 依赖：CMD-T01, TP-T08

## 目标
实现命令执行：点击/快捷键发送 + 定时发送（repeat：count + interval_ms）。

## IMPL `[详细]`

### 签名
```python
class CommandExecutor:
    def __init__(self, send_path: SendPath): ...
    def execute(self, cmd: Command) -> None: ...
        # 变量替换 → 校验追加 → send_path.send_* → 记录历史
    def start_timer(self, cmd: Command) -> None: ...
        # repeat.count 次，间隔 interval_ms
    def stop_timer(self) -> None: ...
```

### 易错点
- 定时发送间隔计时不阻塞 GUI（I/O 线程/定时器）。
- 变量替换在发送时求值（INV-2）。
- 发送走 SendPath 统一路径（INV-1）。

### 完成标准（DoD）
- [ ] 点击/快捷键发送
- [ ] 定时发送 count/interval 正确
- [ ] 发送可中止
- [ ] 记录发送历史

## 禁止事项
- 不绕过 SendPath 直接写 transport
