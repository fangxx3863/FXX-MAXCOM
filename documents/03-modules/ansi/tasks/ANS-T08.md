# ANS-T08: 回滚缓冲区

> 模块：ansi ｜ 依赖：ANS-T07

## 目标
实现回滚缓冲区：被滚出屏幕的行进入环形队列，可上滚查看，不影响终端当前状态（V2 §1.2）。

## IMPL `[详细]`

### 签名
```python
class ScrollbackBuffer:
    def __init__(self, max_lines: int): ...
    def push(self, rows: list[list[Cell]]) -> None: ...   # 滚出的整屏行入队
    def read_back(self, offset: int) -> list[list[Cell]] | None: ...
        # offset>=0 表示上滚 offset 行；返回该位置行，None 表示超出
    def clear(self) -> None: ...
```

### 关键设计
- 环形队列，容量可配（默认 10000 行）。
- 上滚查看时 GUI 渲染回滚区 + 当前屏的拼接；**不修改 ScreenBuffer 状态**（INV：回滚只读）。
- 与 TERM 模块的 selection/搜索配合（O6 待确认）。

### 完成标准（DoD）
- [ ] push/read_back/clear 测试
- [ ] 环形覆盖（超容丢最旧）正确
- [ ] 回滚不修改当前 ScreenBuffer

## 禁止事项
- 回滚区不做样式外的二次处理（搜索待 O6 确认）
