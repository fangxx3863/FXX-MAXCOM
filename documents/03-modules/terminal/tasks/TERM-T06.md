# TERM-T06: 回滚上滚查看

> 模块：terminal ｜ 依赖：ANS-T08, TERM-T01

## 目标
支持向上滚动查看历史输出（回滚缓冲），不影响当前终端状态（INV-3）。

## IMPL `[骨架]`

### 签名
```python
def scroll_view(self, rows: int) -> None: ...
    # 调整 viewport 上滚偏移（非终端自身滚动）
def render(self) -> None: ...
    # 渲染回滚区 + 当前屏的拼接
```

### 完成标准（DoD）
- [ ] 滚轮/快捷键上滚查看历史
- [ ] 回滚查看不修改 ScreenBuffer 状态（当前屏继续更新）
- [ ] 回到底部恢复跟随新输出

## 禁止事项
- 回滚不触发任何发送
