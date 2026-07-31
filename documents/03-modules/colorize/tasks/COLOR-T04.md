# COLOR-T04: 内置规则 — 键值对 + 数值高亮

> 模块：colorize ｜ 依赖：COLOR-T01

## 目标
实现内置规则3（键值对 `KEY: VALUE` 冒号后内容染色）+ 内置规则4（数值高亮：`0x..` / 浮点 / 整数）。

## IMPL `[详细]`

### 签名
```python
KV_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*):\s*([^,\s]+)")
def kv_rule(line: str) -> list[ColoredSegment]:
    # 冒号前的 KEY 默认色，VALUE 用强调色；数值部分额外高亮
    # 返回分段（可多个键值对）

NUM_RE = re.compile(r"(0x[0-9A-Fa-f]+|\d+\.\d+|\d+)")
def number_rule(line: str) -> list[ColoredSegment]:
    # 数字用区分色（强调色）
```

### 完成标准（DoD）
- [ ] 单/多键值对分段正确
- [ ] 十六进制/浮点/整数高亮
- [ ] 与等级规则配合（等级先匹配则整行已染色，键值对不覆盖）

## 禁止事项
- 不改原文，只分段附色
