# FLT-T02: 过滤规则加载 + 独立开关

> 模块：filter ｜ 依赖：FLT-T01, T0-T03

## 目标
从 `02-contracts/filter-rule.schema.json` 加载过滤规则（name/pattern/action/enabled），每条可独立开关。

## IMPL `[骨架]`

### 签名
```python
def load_rules(path: Path) -> list[FilterRule]: ...
    # 读取 filters.toml，pydantic 校验（FilterRule 模型来自 contracts）
def set_enabled(self, name: str, v: bool) -> None: ...
```

### 完成标准（DoD）
- [ ] 规则加载 + 校验（非法配置报错不崩溃）
- [ ] 独立开关
- [ ] 规则变更实时生效（不重启）

## 禁止事项
- 规则文件格式与契约 schema 一致
