# TERM-T03: 本地回显（Local Echo）

> 模块：terminal ｜ 依赖：TERM-T02

## 目标
实现本地回显：远端不回显时可开启，本地同步显示输入（行编辑 + 退格/回车）。

## IMPL `[详细]`

### 签名
```python
class LocalEcho:
    enabled: bool = False   # 显式开关（ADR：本地回显）
    def on_input(self, ch: str) -> str:
        # 返回应显示到屏幕的文本（模拟远端回显效果）
    def set_enabled(self, v: bool) -> None: ...
```

### 伪代码
```
on_input(ch):
    if not enabled: return ""
    match ch:
        可打印: echo_buf += ch; return ch
        backspace: echo_buf 弹尾; return "\b \b"（或清格）
        enter: 清 echo_buf; return "\r\n"
        ctrl 组合: return ""
        default: return ""
```

### 易错点
- 本地回显是**显示层模拟**，不真正发给远端；发送仍走击键直传（不能重复发送）。
- 退格处理需同步屏幕（清当前格 + 回移光标）。
- 开启回显时用户输入字符立即显示，但不经 ANSI 解析（直接写屏幕缓冲）。

### 完成标准（DoD）
- [ ] 开关控制显示/不显示
- [ ] 退格/回车/控制字符显示正确
- [ ] 开启回显不导致重复发送

## 禁止事项
- 本地回显 ≠ 把字符重新写回串口
