# COLOR-T03: 内置规则 — 等级关键词

> 模块：colorize ｜ 依赖：COLOR-T01

## 目标
实现内置规则2：日志等级关键词 `DEBUG: INFO: WARN: WARNING: ERROR: ERR: FATAL: CRITICAL:` 及 `<D> <I> <W> <E> <F>` 尖括号变体 → 整行染色。

## IMPL `[详细]`

### 签名
```python
LEVEL_KEYWORD_RE = re.compile(
    r"(?:^\s*|^<|:?\s+)(DEBUG|INFO|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|D|I|W|E|F)"
)
def keyword_rule(line: str) -> ColoredSegment | None: ...
```

### 完成标准（DoD）
- [ ] 关键词（含冒号变体）与尖括号变体匹配
- [ ] 颜色映射与 COLOR-T02 一致（D灰/I默认/W黄/E红/F红粗）
- [ ] 无匹配返回 None

## 禁止事项
- 不误匹配正文中的普通单词（如 "error handler" 但非等级前缀——用行首/分隔符锚定）
