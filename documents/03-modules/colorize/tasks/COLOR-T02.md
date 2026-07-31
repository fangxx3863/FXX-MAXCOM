# COLOR-T02: 内置规则 — 等级括号

> 模块：colorize ｜ 依赖：COLOR-T01

## 目标
实现内置规则1：日志等级括号 `[D] [I] [W] [E] [F] [DEBUG] [INFO] [WARN] [ERROR] [FATAL] [CRITICAL]` → 整行染色。

## IMPL `[详细]`

### 映射
| 等级 | 颜色 |
|---|---|
| D / DEBUG | 灰 |
| I / INFO | 默认 |
| W / WARN | 黄 |
| E / ERROR | 红 |
| F / FATAL / CRITICAL | 红 + 粗体 |

### 签名
```python
LEVEL_BRACKET_RE = re.compile(r"^\s*\[([DIFW]|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL)\]")
def bracket_rule(line: str) -> ColoredSegment | None: ...
```

### 完成标准（DoD）
- [ ] 每种等级匹配 + 正确颜色
- [ ] 大小写、行首空白处理
- [ ] 无匹配返回 None

## 禁止事项
- 不做非整行染色（该规则 target=line）
