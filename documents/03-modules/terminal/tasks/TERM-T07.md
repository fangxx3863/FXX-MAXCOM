# TERM-T07: 光标闪烁 + 终端状态栏

> 模块：terminal ｜ 依赖：TERM-T01

## 目标
实现光标闪烁（遵循 `CSI ?25 h/l` 显隐）与终端页顶部状态栏（端口、波特率、连接指示灯）。

## IMPL `[骨架]`

### 签名
```python
def render_cursor(self, blink_on: bool) -> None: ...
    # 按光标可见状态 + 闪烁相位画光标块
def set_status(self, status: TerminalStatus) -> None: ...
```

### 完成标准（DoD）
- [ ] 光标随闪烁相位显示/隐藏
- [ ] `CSI ?25 l` 隐藏光标生效
- [ ] 状态栏显示端口/波特率/连接指示灯（复用状态栏组件）

## 禁止事项
- 光标不参与 dirty 行逻辑外操作（每帧重画光标层即可）
