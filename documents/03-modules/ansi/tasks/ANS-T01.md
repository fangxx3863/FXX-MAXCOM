# ANS-T01: SGR 解析与状态

> 模块：ansi ｜ 依赖：T0

## 目标
实现 CSI `n m` SGR 序列解析 + SgrState 结构：16色/256色/真彩色 + 粗体/斜体/下划线/删除线/反色。

## IMPL `[详细]`

### 签名
```python
@dataclass
class SgrState:
    fg: int | None          # 已解析为 RGB tuple? 用 int 索引调色板
    bg: int | None
    bold: bool = False
    italic: bool = False
    underline: bool = False
    strikethrough: bool = False
    reverse: bool = False

def apply_sgr(state: SgrState, params: list[int]) -> SgrState:
    # 返回新状态（immutable，避免共享可变状态）
```

### 伪代码
```
apply_sgr(state, params):
    new = state.copy()
    i = 0
    while i < len(params):
        p = params[i]
        match p:
            0: reset all
            1: bold; 2: faint; 3: italic; 4: underline; 7: reverse; 9: strikethrough
            22: !bold; 23: !italic; 24: !underline; 27: !reverse; 29: !strikethrough
            30-37: fg = p-30 (basic)
            38: # 256 or truecolor, 解析子参数
                 if params[i+1]==5: fg=params[i+2] (256); i+=2
                 elif params[i+1]==2: fg=rgb(params[i+2..4]); i+=4
            39: default fg
            40-47: bg; 48: like 38; 49: default bg
            90-97: bright fg; 100-107: bright bg
        i += 1
    return new
```

### 易错点
- **38/48 是变长子参数**（`38;5;n` 与 `38;2;r;g;b`），i 需正确跳过多余参数。
- `1`（bold）+ 256 色组合：彩色终端常用，确保 bold 不覆盖 fg。
- reverse（反色）在渲染时才交换 fg/bg，SgrState 存原始值。

### 不变量
- apply_sgr 无副作用，返回新对象。
- 所有 param 值落入已知分支，未知值静默忽略。

### 完成标准（DoD）
- [ ] 单元测试：16色/256色/真彩/粗体/斜体/下划线/删除线/反色/reset
- [ ] 变长子参数（38;5 / 38;2）解析正确
- [ ] `mypy --strict` 通过

## 禁止事项
- 不接 GUI；不做颜色到 DPG 的映射（属渲染层）
