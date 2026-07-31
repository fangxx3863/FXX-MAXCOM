# ANS-T04: 滚动区域 + 上滚/下滚

> 模块：ansi ｜ 依赖：ANS-T01 ｜ **"原地刷新"的关键**

## 目标
实现 `CSI n;m r` 设置滚动区域 + 上滚/下滚（"原地更新"不滚屏）。

## IMPL `[详细]`

### 签名
```python
def set_scroll_region(buf: ScreenBuffer, top: int, bottom: int) -> None: ...
def scroll_up(buf: ScreenBuffer, n: int) -> None: ...    # 区域内容上移 n
def scroll_down(buf: ScreenBuffer, n: int) -> None: ...  # 区域内容下移 n
def newline(buf: ScreenBuffer) -> None: ...
```

### 伪代码
```
scroll_up(buf, n):
    region = [top..bottom]
    把 region 内每行整体上移 n：region[i] = region[i+n]
    底部 n 行用空行填充（默认样式）
    标记 region 全 dirty

newline(buf):
    若光标在 bottom：scroll_up(1) 且光标仍停在 bottom 行首
    否则：光标下移一行，列归 0
```

### 易错点
- **滚动只在滚动区域内发生**（INV-3）。区域外行不动。
- newline 在底部触发 scroll_up 而非光标越界。
- 滚动时滚出的行**进入回滚缓冲**（ANS-T08 配合）。

### 完成标准（DoD）
- [ ] 设置区域后滚动只在区域内
- [ ] newline 到底部触发上滚
- [ ] 滚出行进回滚缓冲
- [ ] 原地刷新：模拟进度条场景（回车+重绘）无滚屏

## 禁止事项
- 不做真正的屏幕"滚屏"动画（GUI 层负责视觉）
