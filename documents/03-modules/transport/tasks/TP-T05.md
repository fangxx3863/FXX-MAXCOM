# TP-T05: 自动重连

> 模块：transport ｜ 依赖：TP-T02

## 目标
实现自动重连：端口断开后按间隔自动重连（USB CDC 插拔时不必手动重开）。

## IMPL `[详细]`

### 签名
```python
class AutoReconnect:
    def __init__(self, cfg: AutoReconnect | None): ...
        # max_retries / interval_ms；None 表示关闭
    def notify_disconnect(self) -> None: ...
        # 启动重连计时；端口存在则尝试重开
    def notify_open(self) -> None: ...
        # 连接成功，重置重连计数
    def stop(self) -> None: ...
```

### 伪代码
```
notify_disconnect():
    if not enabled or retries >= max_retries: return
    schedule_after(interval_ms):
        if port still listed: try open; on success reset retries
        else: retries++; reschedule
```

### 完成标准（DoD）
- [ ] 断开→端口复现→自动重连
- [ ] 超 max_retries 停止并提示
- [ ] 手动关闭连接时不触发重连

## 禁止事项
- 重连不阻塞 I/O 线程（用定时器/独立线程）
