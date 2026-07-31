# TERM-T04: 文本选择 → 复制

> 模块：terminal ｜ 依赖：TERM-T01

## 目标
支持鼠标选中屏幕/回滚区文本 → 复制到剪贴板，**不发送**（INV-2）。

## IMPL `[骨架]`

### 签名
```python
class TextSelection:
    def begin(self, cell: (int,int)) -> None: ...
    def extend(self, cell: (int,int)) -> None: ...
    def copy_to_clipboard(self) -> str: ...
        # 提取选中区文本（跨行 + \n），写入剪贴板
    def render_highlight(self) -> set[tuple[int,int]]: ...
        # 返回选中 cell 集，供渲染叠加高亮
```

### 完成标准（DoD）
- [ ] 拖选 → 高亮显示 → 复制到剪贴板
- [ ] 选中区含 CJK 正确（不截半字符）
- [ ] 复制不触发发送

## 禁止事项
- 选中不发送（区别于传统模式发送框）
