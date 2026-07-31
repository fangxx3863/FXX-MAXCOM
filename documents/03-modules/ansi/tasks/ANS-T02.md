# ANS-T02: 光标移动

> 模块：ansi ｜ 依赖：ANS-T01

## 目标
实现光标移动序列：CUU/CUD/CUF/CUB/CHA/CUP/HVP/SCP/RCP/隐藏光标。

## IMPL `[详细]`

### 签名
```python
def cursor_up(buf: ScreenBuffer, n: int) -> None: ...
def cursor_down(buf: ScreenBuffer, n: int) -> None: ...
def cursor_forward(buf: ScreenBuffer, n: int) -> None: ...
def cursor_back(buf: ScreenBuffer, n: int) -> None: ...
def set_cursor_col(buf: ScreenBuffer, n: int) -> None: ...   # CHA (n G)
def set_cursor(buf: ScreenBuffer, row: int, col: int) -> None: ...  # CUP/HVP
def save_cursor(buf: ScreenBuffer) -> None: ...
def restore_cursor(buf: ScreenBuffer) -> None: ...
```

### 易错点
- 光标移动**受滚动区域约束**（INV-3）：不得移出当前滚动区域。
- CUP 的 row/col 是 1-based，需转 0-based。
- 参数缺省为 1（`CSI A` == `CSI 1 A`）。
- 保存/恢复光标与 DECSC/DECRC（ANS-T06）行为可能需合并，注意属性是否一并保存。

### 完成标准（DoD）
- [ ] 每类移动序列有测试（含边界：越界钳制）
- [ ] 1-based 转 0-based 正确
- [ ] 滚动区域内移动约束正确

## 禁止事项
- 不做完整 xterm 光标（如 `CSI n S` 垂直滚动）
