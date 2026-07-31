# COLOR-T05: 用户自定义规则加载 + 独立开关

> 模块：colorize ｜ 依赖：COLOR-T01, T0-T03

## 目标
从 `02-contracts/color-rule.schema.json` 加载用户自定义染色规则（pattern/target/color/bold/priority），每条规则可独立开关。

## IMPL `[详细]`

### 签名
```python
def load_rules(path: Path) -> list[ColorRule]: ...
    # 读取 color_rules.toml，pydantic 校验（ColorRule 模型来自 contracts）
def register_user_rule(engine: ColorizeEngine, rule: ColorRule) -> None: ...

# ColorRule 来自 contracts (02-contracts/color-rule.schema.json)
#   name, pattern, target("line"|"match"), color, bg_color, bold, enabled, priority
```

### 完成标准（DoD）
- [ ] 用户规则加载 + 校验（非法配置报错不崩溃）
- [ ] priority 可插到内置规则之前（如 priority=5 < number=4 之前）
- [ ] 独立开关：只开某规则时其余失效
- [ ] 与内置规则合并后整体优先级正确

## 禁止事项
- 用户规则不得覆盖内置规则的颜色映射（各自独立）
