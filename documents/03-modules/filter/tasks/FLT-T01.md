# FLT-T01: 过滤引擎（规则链）

> 模块：filter ｜ 依赖：T0

## 目标
实现日志行过滤引擎：多规则链，判断一行是否显示。

## IMPL `[详细]`

### 签名
```python
@dataclass
class FilterRule:
    name: str
    pattern: str
    action: Literal["show", "hide"]
    enabled: bool = True
    _compiled: Pattern | None = None

class FilterEngine:
    def add_rule(self, rule: FilterRule) -> None: ...
    def should_show(self, line: str) -> bool: ...
    def reset(self) -> None: ...
```

### 伪代码
```
should_show(line):
    # 默认显示；hide 规则匹配则隐藏；show 规则在白名单场景强制显示
    for rule in self._rules:
        if not rule.enabled: continue
        if rule.action == "hide" and rule.match(line): return False
        if rule.action == "show" and rule.match(line): return True
    return True
```

### 完成标准（DoD）
- [ ] hide 规则隐藏匹配行
- [ ] show 规则白名单优先显示
- [ ] 多规则链正确（首个判定生效）
- [ ] 正则预编译

## 禁止事项
- 不改原始流，只做显示判定
