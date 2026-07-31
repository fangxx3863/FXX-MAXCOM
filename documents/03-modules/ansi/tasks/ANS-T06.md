# ANS-T06: DEC 兼容序列

> 模块：ansi ｜ 依赖：ANS-T01

## 目标
实现 ESC 起始的 DEC 序列：DECSC（ESC 7 保存光标+属性）、DECRC（ESC 8 恢复）、RI（ESC M 反向换行）、IND（ESC D 换行）、NEL（ESC E 换行+回车）、RIS（ESC c 硬重置）。

## IMPL `[骨架]`

### 签名
```python
def save_cursor_state(buf: ScreenBuffer) -> None: ...   # ESC 7
def restore_cursor_state(buf: ScreenBuffer) -> None: ... # ESC 8
def reverse_index(buf: ScreenBuffer) -> None: ...        # ESC M
def index(buf: ScreenBuffer) -> None: ...                # ESC D
def next_line(buf: ScreenBuffer) -> None: ...            # ESC E
def reset(buf: ScreenBuffer) -> None: ...                # ESC c
```

### 易错点
- DECSC 保存**光标位置 + 图形属性**，与 CSI s/u（只存位置）可能需区分——本项目统一按 DECSC 语义（位置+属性）。
- RI 在顶部触发 scroll_down。

### 完成标准（DoD）
- [ ] 每个序列测试
- [ ] DECSC/DECRC 保存并恢复位置 + 属性

## 禁止事项
- 不做完整 DEC 私有模式（如 DECSET/DECRST 大部分不实现）
