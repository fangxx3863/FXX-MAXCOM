# COLOR-T01: 规则链执行引擎

> 模块：colorize ｜ 依赖：T0

## 目标
实现规则链执行：按优先级对一行日志应用首次匹配的规则，产出带颜色标签的段。

## IMPL `[详细]`

### 签名
```python
@dataclass
class ColoredSegment:
    text: str
    fg: str | None
    bg: str | None = None
    bold: bool = False

class ColorizeEngine:
    def register(self, rule: ColorRule) -> None: ...
    def process_line(self, line: str) -> list[ColoredSegment]:
        # 返回染色后的分段；无匹配 → [ColoredSegment(line, None)]
    def reset(self) -> None: ...
```

### 伪代码
```
process_line(line):
    if not master_switch: return [ColoredSegment(line, None)]
    if contains_ansi(line) and ansi_yield: return [ColoredSegment(line, None)]
    rules = sorted(self._rules, key=priority)
    for rule in rules:
        if not rule.enabled: continue
        match = rule.pattern.search(line)
        if match:
            return rule.apply(line, match)   # target=line 整行 / match 仅匹配部分
    return [ColoredSegment(line, None)]
```

### 易错点
- 优先级稳定排序（priority 越小越先）。
- target=match 时：匹配部分着色，其余部分默认色，分段正确拼接。
- 规则正则需预编译（`re.compile`）。

### 完成标准（DoD）
- [ ] 多规则优先级正确（首次匹配生效）
- [ ] target=line / match 两种染色正确
- [ ] 总开关关闭 → 全部默认色
- [ ] 无匹配 → 默认色

## 禁止事项
- 不改日志行文本（只附加颜色标签）
