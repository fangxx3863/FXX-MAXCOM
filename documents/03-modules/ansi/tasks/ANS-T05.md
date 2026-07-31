# ANS-T05: 插入/删除行列

> 模块：ansi ｜ 依赖：ANS-T01 ｜ P1

## 目标
实现 IL（Insert Line）、DL（Delete Line）、DCH（Delete Character）、ECH（Erase Character）、ICH（Insert Character）。

## IMPL `[骨架]`

### 签名
```python
def insert_lines(buf: ScreenBuffer, n: int) -> None: ...
def delete_lines(buf: ScreenBuffer, n: int) -> None: ...
def delete_char(buf: ScreenBuffer, n: int) -> None: ...
def erase_char(buf: ScreenBuffer, n: int) -> None: ...
def insert_char(buf: ScreenBuffer, n: int) -> None: ...
```

### 语义
- IL/DL 作用于当前行所在滚动区域，插入空行/删除行。
- DCH 删除光标右侧 n 字符，行尾补空格。
- ECH 擦除光标起 n 字符（不位移）。
- ICH 光标右侧插入空格。

### 完成标准（DoD）
- [ ] 每种操作有基本测试（含边界）
- [ ] 与滚动区域交互正确

## 禁止事项
- 不做折行；行宽固定
