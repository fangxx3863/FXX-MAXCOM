# ANS-T07: 屏幕缓冲区 + 脏标记 + CJK 宽字符

> 模块：ansi ｜ 依赖：ANS-T01

## 目标
实现 ScreenBuffer：二维字符网格（Cell = char + SgrState）、行级脏标记、CJK 宽字符占 2 列。

## IMPL `[详细]`

### 签名
```python
@dataclass
class Cell:
    char: str
    style: SgrState

class ScreenBuffer:
    def __init__(self, rows: int, cols: int): ...
    def write_char(self, ch: str, style: SgrState) -> None: ...
    def get_dirty_rows(self) -> set[int]: ...
    def clear_dirty(self) -> None: ...
    def get_visible_rows(self) -> list[list[Cell]]: ...
    def row_count(self) -> int: ...
    def col_count(self) -> int: ...
```

### 关键设计
- CJK 宽字符写入时占 col 与 col+1（第二列放占位符，渲染时跳过）。
- 行级脏标记：写操作标记所在行，`get_dirty_rows()` 供 GUI 只重绘 changed_lines（T0-T08 已验证性能）。
- 每行是 `list[Cell]`，行宽固定 cols。

### 易错点
- **CJK 换行边界**：宽字符不能跨行拆断，光标到行尾写宽字符应换行或钳制。
- 脏标记是行级集合，擦除/滚动都要标记受影响行。

### 完成标准（DoD）
- [ ] 写字符/CJK/换行边界测试
- [ ] 脏标记正确（只标记改变的行）
- [ ] CJK 占 2 列、渲染占位正确

## 禁止事项
- 不做文本换行/折行（V1 终端场景以远端换行为准）
