# COLOR-T06: ANSI 让位检测 + 总开关

> 模块：colorize ｜ 依赖：COLOR-T01

## 目标
实现 ANSI 让位检测与总开关：数据含 ANSI 序列时自动染色不插手；总开关关闭则全部默认色。

## IMPL `[详细]`

### 签名
```python
ANSI_RE = re.compile(r"\x1b\[")
def contains_ansi(line: str) -> bool: ...
class ColorizeEngine:  # 扩展现有
    master_enabled: bool = True
    ansi_yield: bool = True
```

### 伪代码
```
process_line(line):
    if not master_enabled: return default(line)
    if ansi_yield and contains_ansi(line): return default(line)
    ... 规则链 ...
```

### 完成标准（DoD）
- [ ] 含 ANSI 的行 → 不染色（让位）
- [ ] ansi_yield=False 时强制应用规则（覆盖让位）
- [ ] 总开关关闭 → 全部默认色

## 禁止事项
- 让位时不尝试解析 ANSI（那是 ansi 模块职责）
