# ANS-T03: 擦除与清屏

> 模块：ansi ｜ 依赖：ANS-T01

## 目标
实现 ED（Erase in Display）与 EL（Erase in Line）序列：`CSI n J` / `CSI n K`（n=0/1/2）。

## IMPL `[骨架]`

### 签名
```python
def erase_in_display(buf: ScreenBuffer, mode: int) -> None: ...   # J
def erase_in_line(buf: ScreenBuffer, mode: int) -> None: ...       # K
```

### 语义
- ED 0：光标到屏幕末尾；ED 1：开头到光标；ED 2：整屏（光标不动）。
- EL 0：光标到行尾；EL 1：行首到光标；EL 2：整行。
- 擦除的 Cell 重置为默认样式，标记 dirty。

### 完成标准（DoD）
- [ ] 6 种 mode 组合测试
- [ ] 擦除后 Cell 样式重置 + dirty 标记

## 禁止事项
- ED 2 不清回滚缓冲（只清可见区）
