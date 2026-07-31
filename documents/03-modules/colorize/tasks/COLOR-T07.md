# COLOR-T07: 颜色调色板

> 模块：colorize ｜ 依赖：COLOR-T01

## 目标
实现颜色调色板：把内置规则的颜色名映射为具体 RGB（暗色主题适配），供渲染层消费。

## IMPL `[骨架]`

### 签名
```python
class Palette:
    def __init__(self, theme: str): ...   # "dark"|"light"
    def resolve(self, color: str) -> tuple[int,int,int]:
        # 命名色（"red"/"yellow"）或 hex（#FF9500）→ RGB
    def level_color(self, level: str) -> tuple[int,int,int]: ...
```

### 完成标准（DoD）
- [ ] 命名色/hex → RGB
- [ ] 暗/亮主题下等级色适配（暗底亮字、亮底深字）
- [ ] 未知颜色名回退默认

## 禁止事项
- 调色板不依赖 DPG 特定 API（纯数据），渲染层负责转 DPG 格式
